import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageBuilder } from "../../src/image/builder.js";
import { ImageStore } from "../../src/store/image-store.js";
import { extractTarGz, readText } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/build");

describe("ImageBuilder", () => {
  let storeDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-builder-test-"));
    store = new ImageStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("fixtures からビルドが成功し、4 レイヤー + manifest + config が保存される", async () => {
    const builder = new ImageBuilder(store);
    const result = await builder.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
    });

    expect(result.ref).toBe("estack-inc/build-fixture:1.0.0");
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.layers.map((l) => l.name).sort()).toEqual([
      "config",
      "identity",
      "knowledge",
      "tools",
    ]);

    // 保存確認
    const loaded = await store.load("estack-inc/build-fixture:1.0.0");
    expect(loaded).not.toBeNull();
    expect(loaded?.manifest.schemaVersion).toBe(2);
    expect(loaded?.layers.size).toBe(4);

    const identityTar = loaded?.layers.get("identity");
    expect(identityTar).toBeDefined();
    const identityFiles = await extractTarGz(identityTar as Buffer);
    expect(identityFiles.has("IDENTITY.md")).toBe(true);
    expect(identityFiles.has("AGENTS-CORE.md")).toBe(true);
    expect(readText(identityFiles, "AGENTS-CORE.md")).toContain("ビルドテスト専用");
  });

  it("ref が refs/<org>/<name>/tags/<tag> の symlink として保存される", async () => {
    const builder = new ImageBuilder(store);
    await builder.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
    });

    const symlinkPath = path.join(storeDir, "refs", "estack-inc", "build-fixture", "tags", "1.0.0");
    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    const realDir = await fs.realpath(symlinkPath);
    expect(path.basename(realDir)).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("同一 Agentfile から同一ダイジェストを生成する（決定論）", async () => {
    const builder1 = new ImageBuilder(store);
    const builder2 = new ImageBuilder(store);
    const fixedNow = new Date("2026-04-17T00:00:00.000Z");
    const r1 = await builder1.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
      now: fixedNow,
    });
    const r2 = await builder2.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
      now: fixedNow,
    });
    expect(r1.digest).toBe(r2.digest);
  });

  it("--dry-run では store.save が呼ばれずレイヤー情報のみ返す", async () => {
    const builder = new ImageBuilder(store);
    const result = await builder.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
      dryRun: true,
    });
    expect(result.layers).toHaveLength(4);
    const loaded = await store.load("estack-inc/build-fixture:1.0.0");
    expect(loaded).toBeNull();
  });

  it("base 継承時にベーステンプレートの内容がレイヤーに反映される", async () => {
    const builder = new ImageBuilder(store);
    await builder.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
    });
    const loaded = await store.load("estack-inc/build-fixture:1.0.0");
    const toolsTar = loaded?.layers.get("tools") as Buffer;
    const toolsFiles = await extractTarGz(toolsTar);
    const toolsJson = JSON.parse(readText(toolsFiles, "tools.json"));
    // monitor template は workflow-controller を含む。child も workflow-controller, file-serve を定義 → マージ後の重複除外
    expect(new Set(toolsJson.builtin)).toEqual(new Set(["workflow-controller", "file-serve"]));
  });

  it("ビルド後の image.json に ImageConfigFile の metadata が反映される", async () => {
    const builder = new ImageBuilder(store);
    const result = await builder.build({
      agentfilePath: path.join(FIXTURE_DIR, "Agentfile.yaml"),
      ref: "estack-inc/build-fixture:1.0.0",
    });

    const imageJsonPath = path.join(storeDir, result.digest.replace(":", "-"), "image.json");
    const stored = JSON.parse(await fs.readFile(imageJsonPath, "utf-8"));
    expect(stored.metadata.name).toBe("build-fixture");
    expect(stored.metadata.version).toBe("1.0.0");
    expect(stored.metadata.description).toBe("build テスト用エージェント");
    expect(stored.metadata.base).toEqual({ ref: "monitor" });
    expect(stored.metadata.tools).toEqual(expect.arrayContaining(["workflow-controller"]));
    expect(stored.metadata.channels.sort()).toEqual(["slack", "webchat"]);
    expect(stored.metadata.knowledgeChunks).toBe(0);
  });
});
