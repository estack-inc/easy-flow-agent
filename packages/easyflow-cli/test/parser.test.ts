import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentfileParseError, parseAgentfile } from "../src/agentfile/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("parseAgentfile", () => {
  it("最小構成をパースできる", async () => {
    const content = readFixture("valid-minimal.yaml");
    const result = await parseAgentfile(content, { basedir: fixturesDir });

    expect(result.agentfile.apiVersion).toBe("easyflow/v1");
    expect(result.agentfile.kind).toBe("Agent");
    expect(result.agentfile.metadata.name).toBe("test-agent");
    expect(result.agentfile.metadata.version).toBe("1.0.0");
    expect(result.agentfile.identity.soul).toBe("あなたはテスト用エージェントです。");
    expect(result.agentfile.channels?.webchat?.enabled).toBe(true);
  });

  it("全フィールド入りをパースできる", async () => {
    const content = readFixture("valid-full.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    expect(result.agentfile.metadata.name).toBe("full-featured-agent");
    expect(result.agentfile.metadata.labels).toEqual({
      env: "production",
      team: "platform",
    });
    expect(result.agentfile.identity.policy).toHaveLength(2);
    expect(result.agentfile.agents_core?.inline).toContain("コアルール");
    expect(result.agentfile.tools?.builtin).toContain("workflow-controller");
    expect(result.agentfile.tools?.builtin).toContain("file-serve");
    expect(result.agentfile.tools?.custom).toHaveLength(1);
    expect(result.agentfile.channels?.slack?.enabled).toBe(true);
    expect(result.agentfile.channels?.webchat?.invite_codes).toEqual(["ABC123", "DEF456"]);
    expect(result.agentfile.config?.model?.default).toBe("claude-sonnet-4-6");
    expect(result.agentfile.config?.rag?.enabled).toBe(true);
    expect(result.resolvedBase).toBe("monitor");
  });

  it("base テンプレート継承でマージされる", async () => {
    const content = readFixture("valid-with-base.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    expect(result.resolvedBase).toBe("monitor");
    expect(result.agentfile.metadata.name).toBe("child-agent");
  });

  it("identity は子が親を完全に置換する", async () => {
    const content = readFixture("valid-with-base.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    // 子の identity が使われる（親の policy は含まれない）
    expect(result.agentfile.identity.name).toBe("カスタムモニター");
    expect(result.agentfile.identity.soul).toBe("あなたはカスタマイズされた監視エージェントです。");
    expect(result.agentfile.identity.policy).toBeUndefined();
  });

  it("knowledge は親の sources に子の sources が追加される", async () => {
    const content = readFixture("valid-with-base.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    // 親の sources (base-docs) + 子の sources (child-docs)
    expect(result.agentfile.knowledge?.sources).toHaveLength(2);
    // テンプレートと子が同じディレクトリにあるため、パスは同じ相対形式で保持される
    expect(result.agentfile.knowledge?.sources[0].path).toBe("base-docs");
    expect(result.agentfile.knowledge?.sources[1].path).toBe("./child-docs");
  });

  it("tools マージで builtin の重複が除外される", async () => {
    const content = readFixture("valid-with-base.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    // 親: [workflow-controller], 子: [workflow-controller, file-serve]
    // マージ後: [workflow-controller, file-serve]（重複除外）
    expect(result.agentfile.tools?.builtin).toEqual(["workflow-controller", "file-serve"]);
  });

  it("config がディープマージされる", async () => {
    const content = readFixture("valid-with-base.yaml");
    const result = await parseAgentfile(content, {
      basedir: fixturesDir,
      templatePaths: [fixturesDir],
    });

    // 親: { model: { default: "claude-haiku-4-5" }, rag: { enabled: false } }
    // 子: { model: { thinking: "claude-opus-4-6" }, rag: { enabled: true } }
    // マージ後: { model: { default: "claude-haiku-4-5", thinking: "claude-opus-4-6" }, rag: { enabled: true } }
    expect(result.agentfile.config?.model?.default).toBe("claude-haiku-4-5");
    expect(result.agentfile.config?.model?.thinking).toBe("claude-opus-4-6");
    expect(result.agentfile.config?.rag?.enabled).toBe(true);
  });

  it("不正な YAML でエラーが返る", async () => {
    const content = "{ invalid yaml: [";
    await expect(parseAgentfile(content, { basedir: fixturesDir })).rejects.toThrow(
      AgentfileParseError,
    );
  });

  it("YAML パースエラーに適切なエラー情報が含まれる", async () => {
    const content = "{ invalid yaml: [";
    try {
      await parseAgentfile(content, { basedir: fixturesDir });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentfileParseError);
      const err = e as AgentfileParseError;
      expect(err.errors).toHaveLength(1);
      expect(err.errors[0].keyword).toBe("yamlParse");
    }
  });

  it("base が明示指定されテンプレートが見つからない場合エラー", async () => {
    const content = `
apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: "1.0.0"
  description: "test"
  author: test
base: estack-inc/nonexistent:latest
identity:
  name: "Test"
  soul: "Test agent."
channels:
  webchat:
    enabled: true
`;
    // templatePaths を空ディレクトリに指定してテンプレートが見つからない状況を再現
    await expect(
      parseAgentfile(content, { basedir: fixturesDir, templatePaths: [fixturesDir] }),
    ).rejects.toThrow(AgentfileParseError);

    try {
      await parseAgentfile(content, { basedir: fixturesDir, templatePaths: [fixturesDir] });
      expect.fail("Should have thrown");
    } catch (e) {
      const err = e as AgentfileParseError;
      expect(err.errors[0].keyword).toBe("baseTemplateNotFound");
      expect(err.errors[0].path).toBe("/base");
    }
  });

  it("組み込みテンプレートで base 継承が動作する", async () => {
    // templatePaths を指定せず、組み込みテンプレートディレクトリを使用
    const content = readFixture("valid-minimal.yaml");
    const result = await parseAgentfile(content, { basedir: fixturesDir });

    // base 省略時はデフォルト monitor テンプレートが組み込みから解決される
    expect(result.resolvedBase).toBe("monitor");
    // 組み込み monitor テンプレートの tools がマージされる
    expect(result.agentfile.tools?.builtin).toContain("workflow-controller");
  });
});
