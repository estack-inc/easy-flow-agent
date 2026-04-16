import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageStore } from "../../src/store/image-store.js";
import type { ImageData } from "../../src/store/types.js";

function createTestImageData(content = "test-layer-data"): ImageData {
  return {
    manifest: { schemaVersion: 2 },
    config: {
      name: "test-agent",
      version: "1.0.0",
      description: "A test agent",
      tools: ["tool-a"],
      channels: ["slack"],
    },
    layers: new Map([["layer0.bin", Buffer.from(content)]]),
  };
}

describe("ImageStore", () => {
  let tmpDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-store-test-"));
    store = new ImageStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("save → load でデータが一致する", async () => {
    const ref = "estack-inc/support:1.0.0";
    const data = createTestImageData();
    await store.save(ref, data);

    const loaded = await store.load(ref);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest).toEqual(data.manifest);
    expect(loaded!.config).toEqual(data.config);
    expect(loaded!.layers.get("layer0.bin")).toEqual(data.layers.get("layer0.bin"));
  });

  it("list で複数イメージを全件取得できる", async () => {
    await store.save("org/agent-a:1.0.0", createTestImageData("a"));
    await store.save("org/agent-b:2.0.0", createTestImageData("b"));

    const images = await store.list();
    expect(images.length).toBe(2);
    const refs = images.map((img) => img.ref).sort();
    expect(refs).toEqual(["org/agent-a:1.0.0", "org/agent-b:2.0.0"]);
  });

  it("remove 後に load で null が返る", async () => {
    const ref = "org/agent:1.0.0";
    await store.save(ref, createTestImageData());

    const removed = await store.remove(ref);
    expect(removed).toBe(true);

    const loaded = await store.load(ref);
    expect(loaded).toBeNull();
  });

  it("ref パースが正しい", () => {
    const parsed = ImageStore.parseRef("estack-inc/support:1.0.0");
    expect(parsed).toEqual({ org: "estack-inc", name: "support", tag: "1.0.0" });
  });

  it("ref パース — タグなしは latest", () => {
    const parsed = ImageStore.parseRef("estack-inc/support");
    expect(parsed).toEqual({ org: "estack-inc", name: "support", tag: "latest" });
  });

  it("prune でタグなしイメージが削除される", async () => {
    const ref = "org/agent:1.0.0";
    await store.save(ref, createTestImageData());

    // Remove the tag symlink but leave the digest directory
    await store.remove(ref);
    // remove only removes the digest dir too when no other refs exist,
    // so let's create a scenario: save, then manually break the symlink
    await store.save(ref, createTestImageData("prune-test"));
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(tmpDir, "refs", org, name, "tags", tag);
    await fs.unlink(tagDir);

    const result = await store.prune();
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it("存在しない ref の load → null", async () => {
    const loaded = await store.load("nonexistent/agent:1.0.0");
    expect(loaded).toBeNull();
  });

  it("同一 digest に複数 ref を付けた場合、list で全 ref が返る", async () => {
    const data = createTestImageData("shared-content");
    await store.save("org/agent:1.0.0", data);
    await store.save("org/agent:latest", data);

    const images = await store.list();
    const refs = images.map((img) => img.ref).sort();
    expect(refs).toEqual(["org/agent:1.0.0", "org/agent:latest"]);
  });

  it("単一セグメント ref の save → list で ref が維持される", async () => {
    await store.save("agent:latest", createTestImageData("single-seg"));
    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe("agent:latest");
  });

  it("同一 ref を別 digest で上書きした場合、list に古い ref が残らない", async () => {
    await store.save("org/agent:1.0.0", createTestImageData("v1"));
    await store.save("org/agent:1.0.0", createTestImageData("v2"));

    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe("org/agent:1.0.0");

    // 古い digest ディレクトリが孤立 → prune で削除できる
    const pruned = await store.prune();
    expect(pruned.removed).toBe(1);
    expect(pruned.freedBytes).toBeGreaterThan(0);
  });

  it("パストラバーサルを含む ref は拒否される", async () => {
    const data = createTestImageData();
    await expect(store.save("../../tmp/x:tag", data)).rejects.toThrow("Invalid ref");
    await expect(store.load("org/../etc:tag")).rejects.toThrow("Invalid ref");
    await expect(store.remove("../escape:latest")).rejects.toThrow("Invalid ref");
  });

  it("tag にスラッシュを含む ref は拒否される", async () => {
    const data = createTestImageData();
    await expect(store.save("org/agent:release/canary", data)).rejects.toThrow("Invalid ref");
  });

  it("空セグメントを含む ref は拒否される", async () => {
    const data = createTestImageData();
    await expect(store.save("org//agent:1.0.0", data)).rejects.toThrow("Invalid ref");
    await expect(store.save("org/agent/:1.0.0", data)).rejects.toThrow("Invalid ref");
    await expect(store.save("/agent:1.0.0", data)).rejects.toThrow("Invalid ref");
  });

  it("パストラバーサルを含む layer 名は save で拒否される", async () => {
    const data = createTestImageData();
    data.layers.set("../../etc/passwd", Buffer.from("bad"));
    await expect(store.save("org/agent:1.0.0", data)).rejects.toThrow("Invalid layer name");
  });

  it("複数コロンを含む ref は拒否される", async () => {
    const data = createTestImageData();
    await expect(store.save("org/agent:release:2026", data)).rejects.toThrow(
      'at most one ":" is allowed',
    );
  });

  it("ストア外を指す symlink は load で無視される", async () => {
    const ref = "org/agent:1.0.0";
    await store.save(ref, createTestImageData());
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(tmpDir, "refs", org, name, "tags", tag);

    // symlink をストア外のディレクトリに差し替え
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-store-"));
    await fs.writeFile(path.join(outsideDir, "manifest.json"), "{}");
    await fs.writeFile(path.join(outsideDir, "config.json"), "{}");
    await fs.unlink(tagDir);
    await fs.symlink(outsideDir, tagDir);

    const loaded = await store.load(ref);
    expect(loaded).toBeNull();

    // list でもストア外を指す symlink は除外される
    const images = await store.list();
    expect(images.length).toBe(0);

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("layer 名境界が異なるデータは別 digest になる", async () => {
    const dataA: ImageData = {
      manifest: { schemaVersion: 2 },
      config: { name: "a", version: "1.0.0", description: "", tools: [], channels: [] },
      layers: new Map([["a", Buffer.from("bc")]]),
    };
    const dataB: ImageData = {
      manifest: { schemaVersion: 2 },
      config: { name: "a", version: "1.0.0", description: "", tools: [], channels: [] },
      layers: new Map([["ab", Buffer.from("c")]]),
    };
    const storedA = await store.save("org/a:1.0.0", dataA);
    const storedB = await store.save("org/b:1.0.0", dataB);
    expect(storedA.digest).not.toBe(storedB.digest);
  });

  it("sha256- で始まる org 名の ref が save/list で正しく扱われる", async () => {
    const ref = "sha256-tools/agent:1.0.0";
    await store.save(ref, createTestImageData("sha256-org"));
    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe(ref);

    const loaded = await store.load(ref);
    expect(loaded).not.toBeNull();
  });

  it("org なし ref と _ org の ref が衝突しない", async () => {
    await store.save("agent:latest", createTestImageData("no-org"));
    await store.save("_/agent:latest", createTestImageData("underscore-org"));

    const images = await store.list();
    expect(images.length).toBe(2);
    const refs = images.map((img) => img.ref).sort();
    expect(refs).toEqual(["_/agent:latest", "agent:latest"]);
  });

  it("name に tags を含む ref が list で正しく復元される", async () => {
    await store.save("org/tags:1.0.0", createTestImageData("tags-name"));
    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe("org/tags:1.0.0");
  });
});
