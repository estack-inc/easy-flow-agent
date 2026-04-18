import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const ENTRY_PATH = path.resolve(import.meta.dirname, "../../src/cli/index.ts");

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY_PATH, ...args], {
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
    const { stderr } = await runCli(["push"]);
    expect(stderr).toContain("easyflow push は現在未実装です。");
  });

  describe("images", () => {
    let storeDir: string;

    beforeEach(async () => {
      storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-images-cli-test-"));
    });

    afterEach(async () => {
      await fs.rm(storeDir, { recursive: true, force: true });
    });

    it("images — 空ストアでメッセージが表示される", async () => {
      const { stdout } = await runCli(["images"], { EASYFLOW_STORE_DIR: storeDir });
      expect(stdout).toContain("ローカルイメージはありません");
    });

    it("images rm — 存在しない ref でエラーメッセージが出る", async () => {
      const { stderr } = await runCli(["images", "rm", "org/x:1.0.0"], {
        EASYFLOW_STORE_DIR: storeDir,
      });
      expect(stderr).toContain("イメージが見つかりません");
    });

    it("images prune — 空ストアで 0 件と表示される", async () => {
      const { stdout } = await runCli(["images", "prune"], { EASYFLOW_STORE_DIR: storeDir });
      expect(stdout).toContain("0 件削除しました");
    });
  });

  describe("--dry-run", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-dryrun-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("config set --dry-run で設定が保存されない", async () => {
      const { stdout } = await runCli(
        ["--dry-run", "config", "set", "auth[example.com].token", "secret"],
        { EASYFLOW_CONFIG_DIR: tmpDir },
      );
      expect(stdout).toContain("[dry-run]");

      const { stdout: getOut } = await runCli(["config", "get", "auth[example.com].token"], {
        EASYFLOW_CONFIG_DIR: tmpDir,
      });
      expect(getOut).toContain("未設定");
    });

    it("images rm --dry-run で削除されない", async () => {
      const { stdout } = await runCli(["--dry-run", "images", "rm", "org/agent:1.0.0"], {
        EASYFLOW_STORE_DIR: tmpDir,
      });
      expect(stdout).toContain("[dry-run]");
    });

    it("images prune --dry-run で削除されない", async () => {
      const { stdout } = await runCli(["--dry-run", "images", "prune"], {
        EASYFLOW_STORE_DIR: tmpDir,
      });
      expect(stdout).toContain("[dry-run]");
    });
  });
});
