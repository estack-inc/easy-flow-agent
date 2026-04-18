import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAgentfile } from "../../src/validate/validator.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures");
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../templates");

describe("validateAgentfile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-validate-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("valid-minimal.yaml で ok:true を返す", async () => {
    const result = await validateAgentfile(path.join(FIXTURE_DIR, "valid-minimal.yaml"), [
      TEMPLATES_DIR,
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("存在しない Agentfile で category:file-missing エラーを返す", async () => {
    const result = await validateAgentfile(path.join(tmpDir, "nonexistent.yaml"), [TEMPLATES_DIR]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].category).toBe("file-missing");
  });

  it("スキーマエラー（不正な name）で category:schema エラーを返す", async () => {
    const result = await validateAgentfile(path.join(FIXTURE_DIR, "invalid-bad-name.yaml"), [
      TEMPLATES_DIR,
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.category === "schema")).toBe(true);
  });

  it("存在しないファイルパスを参照する知識ソースで category:file-missing エラーを返す", async () => {
    const agentfileContent = `apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: "1.0.0"
  description: "テスト"
  author: test
identity:
  name: "テスト"
  soul: "テスト用。"
knowledge:
  sources:
    - path: ./nonexistent-dir
      type: agents_rule
      description: "存在しないディレクトリ"
channels:
  webchat:
    enabled: true
`;
    const agentfilePath = path.join(tmpDir, "Agentfile.yaml");
    await fs.writeFile(agentfilePath, agentfileContent);

    const result = await validateAgentfile(agentfilePath, [TEMPLATES_DIR]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.category === "file-missing")).toBe(true);
  });

  it("不明な builtin ツールで category:tool-unknown エラーを返す", async () => {
    const agentfileContent = `apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: "1.0.0"
  description: "テスト"
  author: test
identity:
  name: "テスト"
  soul: "テスト用。"
tools:
  builtin:
    - unknown-tool-xyz
channels:
  webchat:
    enabled: true
`;
    const agentfilePath = path.join(tmpDir, "Agentfile.yaml");
    await fs.writeFile(agentfilePath, agentfileContent);

    const result = await validateAgentfile(agentfilePath, [TEMPLATES_DIR]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.category === "tool-unknown")).toBe(true);
  });

  it("存在しない base テンプレートで category:base-resolution エラーを返す", async () => {
    // 有効なフォーマットだが存在しないテンプレートの ref を使用
    const agentfileContent = `apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: "1.0.0"
  description: "テスト"
  author: test
base: estack-inc/nonexistent:latest
identity:
  name: "テスト"
  soul: "テスト用。"
channels:
  webchat:
    enabled: true
`;
    const agentfilePath = path.join(tmpDir, "Agentfile.yaml");
    await fs.writeFile(agentfilePath, agentfileContent);

    // 空のテンプレートパス（テンプレートが見つからない）
    const emptyTemplatesDir = path.join(tmpDir, "no-templates");
    await fs.mkdir(emptyTemplatesDir, { recursive: true });

    const result = await validateAgentfile(agentfilePath, [emptyTemplatesDir]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.category === "base-resolution")).toBe(true);
  });

  it("複数エラーがある場合すべて返される", async () => {
    const agentfileContent = `apiVersion: easyflow/v1
kind: Agent
metadata:
  name: "Bad Name!"
  version: "not-semver"
  description: "テスト"
  author: test
identity:
  name: "テスト"
  soul: "テスト用。"
channels:
  webchat:
    enabled: true
`;
    const agentfilePath = path.join(tmpDir, "Agentfile.yaml");
    await fs.writeFile(agentfilePath, agentfileContent);

    const result = await validateAgentfile(agentfilePath, [TEMPLATES_DIR]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it("file フィールドにパスが設定される", async () => {
    const filePath = path.join(FIXTURE_DIR, "valid-minimal.yaml");
    const result = await validateAgentfile(filePath, [TEMPLATES_DIR]);
    expect(result.file).toBe(filePath);
  });
});
