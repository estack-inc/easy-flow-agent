import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTemplateSnapshot } from "../../src/convert/template-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleTemplateDir = join(__dirname, "../fixtures/convert/sample-template");

describe("loadTemplateSnapshot", () => {
  it("既知のファイルを全て読み込める", async () => {
    const snapshot = await loadTemplateSnapshot(sampleTemplateDir);

    expect(snapshot.rootDir).toBe(sampleTemplateDir);
    expect(snapshot.identityMd).toContain("サンプルエージェント");
    expect(snapshot.soulMd).toContain("あなたはテスト用のエージェント");
    expect(snapshot.policyMd).toContain("事実と推測");
    expect(snapshot.agentsMd).toContain("業務ルール");
    expect(snapshot.agentsCoreMd).toContain("コアルール");
    expect(snapshot.toolsMd).toContain("散文のみ");
    expect(snapshot.readmeMd).toContain("サンプルテンプレート");
    expect(snapshot.entrypointSh).toContain("workflow-controller");
    expect(snapshot.metaJson).toEqual({
      name: "sample-template",
      version: "0.2.0",
      description: "テスト用のサンプルテンプレートです。",
      author: "estack-inc",
    });
    expect(snapshot.hasWorkspaceDir).toBe(false);
  });

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "template-loader-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("部分ファイルのみ存在するテンプレートは未定義欄を undefined にする", async () => {
    writeFileSync(join(tmpDir, "IDENTITY.md"), "# Only identity");

    const snapshot = await loadTemplateSnapshot(tmpDir);

    expect(snapshot.identityMd).toBe("# Only identity");
    expect(snapshot.soulMd).toBeUndefined();
    expect(snapshot.policyMd).toBeUndefined();
    expect(snapshot.agentsMd).toBeUndefined();
    expect(snapshot.agentsCoreMd).toBeUndefined();
    expect(snapshot.toolsMd).toBeUndefined();
    expect(snapshot.readmeMd).toBeUndefined();
    expect(snapshot.metaJson).toBeUndefined();
    expect(snapshot.entrypointSh).toBeUndefined();
    expect(snapshot.hasWorkspaceDir).toBe(false);
  });

  it("workspace ディレクトリが存在すれば hasWorkspaceDir=true", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "x");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpDir, "workspace"));

    const snapshot = await loadTemplateSnapshot(tmpDir);

    expect(snapshot.hasWorkspaceDir).toBe(true);
  });

  it("meta.json が不正な JSON のときエラーを投げる", async () => {
    writeFileSync(join(tmpDir, "meta.json"), "{ not-json");

    await expect(loadTemplateSnapshot(tmpDir)).rejects.toThrow(/meta\.json/);
  });
});
