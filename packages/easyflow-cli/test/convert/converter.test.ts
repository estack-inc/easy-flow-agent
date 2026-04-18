import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentfile } from "../../src/agentfile/parser.js";
import { convertTemplateToAgentfile } from "../../src/convert/converter.js";
import { loadTemplateSnapshot } from "../../src/convert/template-loader.js";
import { ConversionError, type TemplateSnapshot } from "../../src/convert/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleTemplateDir = join(__dirname, "../fixtures/convert/sample-template");

describe("convertTemplateToAgentfile", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "converter-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSnapshot(partial: Partial<TemplateSnapshot> = {}): TemplateSnapshot {
    return {
      rootDir: tmpRoot,
      hasWorkspaceDir: false,
      soulMd: "# SOUL\nあなたはテスト用です。",
      metaJson: { name: "mini", version: "1.0.0", description: "x", author: "estack-inc" },
      ...partial,
    };
  }

  it("最小の snapshot から Agentfile を生成できる", async () => {
    const result = await convertTemplateToAgentfile(makeSnapshot(), { templateName: "mini" });

    expect(result.agentfile.apiVersion).toBe("easyflow/v1");
    expect(result.agentfile.kind).toBe("Agent");
    expect(result.agentfile.metadata.name).toBe("mini");
    expect(result.agentfile.metadata.version).toBe("1.0.0");
    expect(result.agentfile.identity.soul).toContain("あなたはテスト用です");
    expect(result.agentfile.knowledge).toBeUndefined();
    expect(result.agentfile.agents_core).toBeUndefined();
    expect(result.agentfile.config?.rag?.enabled).toBeUndefined();
    expect(result.agentfile.tools?.builtin).toEqual(["workflow-controller"]);
    expect(result.agentfile.channels?.slack?.enabled).toBe(true);
    expect(result.agentfile.channels?.line?.enabled).toBe(true);
    expect(result.agentfile.channels?.webchat?.enabled).toBe(true);
  });

  it("SOUL.md 欠落で ConversionError", async () => {
    await expect(
      convertTemplateToAgentfile(makeSnapshot({ soulMd: undefined }), { templateName: "mini" }),
    ).rejects.toBeInstanceOf(ConversionError);
  });

  it("AGENTS.md があれば knowledge.sources が設定される", async () => {
    writeFileSync(join(tmpRoot, "AGENTS.md"), "# rules");
    const result = await convertTemplateToAgentfile(makeSnapshot({ agentsMd: "# rules" }), {
      templateName: "mini",
    });

    expect(result.agentfile.knowledge?.sources).toEqual([
      { path: "./AGENTS.md", type: "agents_rule", description: "詳細業務ルール" },
    ]);
  });

  it("AGENTS-CORE.md があれば agents_core.file と rag.enabled が設定される", async () => {
    writeFileSync(join(tmpRoot, "AGENTS-CORE.md"), "# core");
    const result = await convertTemplateToAgentfile(makeSnapshot({ agentsCoreMd: "# core" }), {
      templateName: "mini",
    });

    expect(result.agentfile.agents_core?.file).toBe("./AGENTS-CORE.md");
    expect(result.agentfile.config?.rag?.enabled).toBe(true);
  });

  it("IDENTITY.md の H1 が identity.name になる", async () => {
    const result = await convertTemplateToAgentfile(
      makeSnapshot({ identityMd: "# すごいエージェント\n説明" }),
      { templateName: "mini" },
    );

    expect(result.agentfile.identity.name).toBe("すごいエージェント");
  });

  it("H1 がファイル名そのもの（例: IDENTITY.md）なら meta.name にフォールバックする", async () => {
    const result = await convertTemplateToAgentfile(
      makeSnapshot({
        identityMd: "# IDENTITY.md\n本文",
        metaJson: {
          name: "モニター企業向けデフォルト",
          version: "1.0.0",
          description: "x",
          author: "estack-inc",
        },
      }),
      { templateName: "monitor" },
    );

    expect(result.agentfile.identity.name).toBe("モニター企業向けデフォルト");
  });

  it("H1 がファイル名を前置した文書タイトル（例: IDENTITY.md — 役割定義）なら meta.name にフォールバックする", async () => {
    const result = await convertTemplateToAgentfile(
      makeSnapshot({
        identityMd: "# IDENTITY.md — <AGENT_NAME> の役割定義\n本文",
        metaJson: {
          name: "経営参謀・エグゼクティブアシスタント",
          version: "1.0.0",
          description: "x",
          author: "estack-inc",
        },
      }),
      { templateName: "executive-assistant" },
    );

    expect(result.agentfile.identity.name).toBe("経営参謀・エグゼクティブアシスタント");
  });

  it("POLICY.md の箇条書きが identity.policy になる", async () => {
    const policyMd = "# POLICY\n\n- 最初のルール\n- 次のルール\n  - サブ項目\n";
    const result = await convertTemplateToAgentfile(makeSnapshot({ policyMd }), {
      templateName: "mini",
    });

    expect(result.agentfile.identity.policy).toEqual(["最初のルール", "次のルール", "サブ項目"]);
  });

  it("未知テンプレート名 + デフォルトツールのみのとき warnings が出る", async () => {
    const result = await convertTemplateToAgentfile(makeSnapshot(), {
      templateName: "stranger",
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("手動で tools.builtin"))).toBe(true);
  });

  it("YAML 出力は parseAgentfile でバリデーション成功する", async () => {
    const result = await convertTemplateToAgentfile(makeSnapshot(), { templateName: "mini" });
    const parsed = await parseAgentfile(result.yaml, {
      basedir: tmpRoot,
      templatePaths: [],
    });
    expect(parsed.agentfile.metadata.name).toBe("mini");
  });

  it("fixture から変換した結果が parseAgentfile を通過する", async () => {
    const snapshot = await loadTemplateSnapshot(sampleTemplateDir);
    const result = await convertTemplateToAgentfile(snapshot, { templateName: "monitor" });

    const parsed = await parseAgentfile(result.yaml, {
      basedir: sampleTemplateDir,
      templatePaths: [],
    });
    expect(parsed.agentfile.metadata.name).toBe("sample-template");
    expect(parsed.agentfile.identity.name).toBe("サンプルエージェント");
    expect(parsed.agentfile.identity.policy).toContain("事実と推測を混同しない");
    expect(parsed.agentfile.tools?.builtin).toContain("workflow-controller");
    expect(parsed.agentfile.agents_core?.file).toBe("./AGENTS-CORE.md");
    expect(parsed.agentfile.knowledge?.sources?.[0].path).toBe("./AGENTS.md");
    expect(parsed.agentfile.config?.rag?.enabled).toBe(true);
  });

  it("入力ファイルの一覧が inputFiles に列挙される", async () => {
    const snapshot = await loadTemplateSnapshot(sampleTemplateDir);
    const result = await convertTemplateToAgentfile(snapshot, { templateName: "monitor" });

    expect(result.inputFiles).toEqual(
      expect.arrayContaining([
        "IDENTITY.md",
        "SOUL.md",
        "POLICY.md",
        "AGENTS.md",
        "AGENTS-CORE.md",
        "meta.json",
        "entrypoint.sh",
      ]),
    );
  });

  it("YAML は js-yaml でパース可能な構造を保つ", async () => {
    const result = await convertTemplateToAgentfile(makeSnapshot(), { templateName: "mini" });
    const reparsed = yaml.load(result.yaml) as Record<string, unknown>;
    expect(reparsed.apiVersion).toBe("easyflow/v1");
    expect(reparsed.kind).toBe("Agent");
  });

  it("meta.name が非 ASCII のとき templateName に kebab-case フォールバック", async () => {
    const result = await convertTemplateToAgentfile(
      makeSnapshot({
        metaJson: {
          name: "モニター企業向けデフォルト",
          version: "1.0.0",
          description: "x",
          author: "estack-inc",
        },
      }),
      { templateName: "monitor" },
    );

    expect(result.agentfile.metadata.name).toBe("monitor");
  });

  it("description は改行除去・200 字以内に切り詰められる", async () => {
    const longDesc = "あ".repeat(250);
    const result = await convertTemplateToAgentfile(
      makeSnapshot({
        metaJson: { name: "mini", version: "1.0.0", description: longDesc, author: "estack-inc" },
      }),
      { templateName: "mini" },
    );

    expect(result.agentfile.metadata.description.length).toBeLessThanOrEqual(200);
  });
});
