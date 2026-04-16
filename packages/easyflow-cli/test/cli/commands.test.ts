import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const BIN_PATH = path.resolve(import.meta.dirname, "../../bin/easyflow.mjs");
const TSX_PATH = path.resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx");

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(TSX_PATH, [BIN_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 10000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("CLI commands", () => {
  it("--version でバージョン番号が表示される", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("--help でコマンド一覧が表示される", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("config");
    expect(stdout).toContain("images");
    expect(stdout).toContain("build");
    expect(stdout).toContain("deploy");
  });

  describe("config set/get", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-cli-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("config set → config get で値が取得できる", async () => {
      const { stdout: setOut } = await runCli(["config", "set", "registry", "custom.io"], {
        EASYFLOW_CONFIG_DIR: tmpDir,
      });
      expect(setOut).toContain("registry = custom.io");

      const { stdout: getOut } = await runCli(["config", "get", "registry"], {
        EASYFLOW_CONFIG_DIR: tmpDir,
      });
      expect(getOut.trim()).toBe("custom.io");
    });
  });

  it("未実装コマンドでエラーメッセージが表示される", async () => {
    const { stderr } = await runCli(["build"]);
    expect(stderr).toContain("easyflow build は現在未実装です。");
  });
});
