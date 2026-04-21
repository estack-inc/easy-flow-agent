import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecretFile } from "../../src/deploy/secret-file.js";
import { EasyflowError } from "../../src/utils/errors.js";

describe("loadSecretFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-secret-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("基本的な KEY=VALUE をパースする", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "FOO=bar\nBAZ=qux\n");

    const result = await loadSecretFile(filePath);
    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBe("qux");
  });

  it("値の二重引用符を除去する", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, 'GEMINI_API_KEY="test-gemini-key"\n');

    const result = await loadSecretFile(filePath);
    expect(result.GEMINI_API_KEY).toBe("test-gemini-key");
  });

  it("コメント行をスキップする", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "# This is a comment\nFOO=bar\n");

    const result = await loadSecretFile(filePath);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.FOO).toBe("bar");
  });

  it("空行をスキップする", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "\nFOO=bar\n\nBAZ=qux\n");

    const result = await loadSecretFile(filePath);
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("フィクスチャファイルを正常にパースする", async () => {
    const fixturePath = path.join(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../fixtures/deploy/secrets.env",
    );
    const result = await loadSecretFile(fixturePath);

    expect(result.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(result.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
    expect(result.GEMINI_API_KEY).toBe("test-gemini-key");
    // コメントはキーとして含まれない
    expect(Object.keys(result)).not.toContain("# This is a comment");
  });

  it("無効なキー名で EasyflowError をスローする", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "123INVALID=value\n");

    await expect(loadSecretFile(filePath)).rejects.toThrow(EasyflowError);
  });

  it("ハイフンを含むキー名で EasyflowError をスローする", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "INVALID-KEY=value\n");

    await expect(loadSecretFile(filePath)).rejects.toThrow(EasyflowError);
  });

  it("ファイルが存在しない場合 EasyflowError をスローする", async () => {
    const filePath = path.join(tmpDir, "nonexistent.env");
    await expect(loadSecretFile(filePath)).rejects.toThrow(EasyflowError);
  });

  it("アンダースコアで始まるキー名を許可する", async () => {
    const filePath = path.join(tmpDir, "test.env");
    await fs.writeFile(filePath, "_PRIVATE_KEY=secret\n");

    const result = await loadSecretFile(filePath);
    expect(result._PRIVATE_KEY).toBe("secret");
  });
});
