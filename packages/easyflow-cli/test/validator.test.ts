import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentfileParseError, parseAgentfile } from "../src/agentfile/parser.js";
import type { Agentfile } from "../src/agentfile/types.js";
import { validateSchema, validateSemantic } from "../src/agentfile/validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

/** テスト用の最小有効 Agentfile オブジェクト */
function createValidAgentfile(overrides: Record<string, unknown> = {}): Agentfile {
  return {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "Test agent",
      author: "test",
    },
    identity: {
      name: "Test",
      soul: "You are a test agent.",
    },
    channels: {
      webchat: { enabled: true },
    },
    ...overrides,
  } as Agentfile;
}

describe("validateSchema", () => {
  it("有効な Agentfile でエラーなし", () => {
    const errors = validateSchema(createValidAgentfile());
    expect(errors).toHaveLength(0);
  });

  it("metadata.name が大文字を含む場合エラー", () => {
    const data = createValidAgentfile({
      metadata: {
        name: "BadName",
        version: "1.0.0",
        description: "test",
        author: "test",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("/metadata/name"))).toBe(true);
  });

  it("metadata.name がスペースを含む場合エラー", () => {
    const data = createValidAgentfile({
      metadata: {
        name: "bad name",
        version: "1.0.0",
        description: "test",
        author: "test",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("metadata.name が 2 文字以下でエラー", () => {
    const data = createValidAgentfile({
      metadata: {
        name: "ab",
        version: "1.0.0",
        description: "test",
        author: "test",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("metadata.name が 65 文字以上でエラー", () => {
    const data = createValidAgentfile({
      metadata: {
        name: "a".repeat(65),
        version: "1.0.0",
        description: "test",
        author: "test",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("version が semver でない文字列でエラー", () => {
    const data = createValidAgentfile({
      metadata: {
        name: "test-agent",
        version: "not-semver",
        description: "test",
        author: "test",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.keyword === "format")).toBe(true);
  });

  it("identity.soul が未指定でエラー", () => {
    const data = {
      apiVersion: "easyflow/v1",
      kind: "Agent",
      metadata: {
        name: "test-agent",
        version: "1.0.0",
        description: "test",
        author: "test",
      },
      identity: {
        name: "Test",
      },
      channels: {
        webchat: { enabled: true },
      },
    };
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.keyword === "required")).toBe(true);
  });

  it("identity.soul が空文字でエラー", () => {
    const data = createValidAgentfile({
      identity: {
        name: "Test",
        soul: "",
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("不明な builtin ツール名でエラー", () => {
    const data = createValidAgentfile({
      tools: {
        builtin: ["unknown-tool"],
      },
    });
    const errors = validateSchema(data);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateSemantic", () => {
  it("有効な Agentfile でエラーなし", () => {
    const agentfile = createValidAgentfile();
    const errors = validateSemantic(agentfile, { basedir: fixturesDir });
    expect(errors).toHaveLength(0);
  });

  it("存在しない knowledge path でエラー", () => {
    const agentfile = createValidAgentfile({
      knowledge: {
        sources: [
          {
            path: "./nonexistent-dir",
            type: "agents_rule",
            description: "test",
          },
        ],
      },
    });
    const errors = validateSemantic(agentfile, { basedir: fixturesDir });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.keyword === "fileExists")).toBe(true);
  });

  it("agents_core の file と inline 同時指定でエラー", () => {
    const agentfile = createValidAgentfile({
      agents_core: {
        file: "./some-file.md",
        inline: "Some content",
      },
    });
    const errors = validateSemantic(agentfile, { basedir: fixturesDir });
    expect(errors.some((e) => e.keyword === "agentsCoreExclusive")).toBe(true);
  });

  it("全チャネル無効でエラー", () => {
    const agentfile = createValidAgentfile({
      channels: {
        webchat: { enabled: false },
        slack: { enabled: false },
      },
    });
    const errors = validateSemantic(agentfile, { basedir: fixturesDir });
    expect(errors.some((e) => e.keyword === "channelEnabled")).toBe(true);
  });

  it("channels が未定義でエラー", () => {
    const agentfile = createValidAgentfile();
    // channels を明示的に undefined にする
    (agentfile as Record<string, unknown>).channels = undefined;
    const errors = validateSemantic(agentfile, { basedir: fixturesDir });
    expect(errors.some((e) => e.keyword === "channelEnabled")).toBe(true);
  });
});

describe("parseAgentfile (バリデーションエラー)", () => {
  it("invalid-missing-soul.yaml で AgentfileParseError がスローされる", async () => {
    const content = readFixture("invalid-missing-soul.yaml");
    await expect(parseAgentfile(content, { basedir: fixturesDir })).rejects.toThrow(
      AgentfileParseError,
    );
  });

  it("invalid-bad-name.yaml で AgentfileParseError がスローされる", async () => {
    const content = readFixture("invalid-bad-name.yaml");
    await expect(parseAgentfile(content, { basedir: fixturesDir })).rejects.toThrow(
      AgentfileParseError,
    );
  });

  it("エラーに JSON Pointer パスと人間向けメッセージが含まれる", async () => {
    const content = readFixture("invalid-bad-name.yaml");
    try {
      await parseAgentfile(content, { basedir: fixturesDir });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentfileParseError);
      const err = e as AgentfileParseError;
      expect(err.errors.length).toBeGreaterThan(0);
      // エラーには path（JSON Pointer）と message が含まれる
      for (const error of err.errors) {
        expect(error.path).toBeDefined();
        expect(error.message).toBeDefined();
        expect(error.keyword).toBeDefined();
      }
    }
  });
});
