import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const ENTRY_PATH = path.resolve(import.meta.dirname, "../../src/cli/index.ts");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/build");

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 20000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

describe("easyflow build (CLI)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-build-cli-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("--file 必須オプションが無いとエラーになる", async () => {
    const { stderr, code } = await runCli(["build", "-t", "foo/bar:1.0"], {
      EASYFLOW_STORE_DIR: storeDir,
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/required option|必須/i);
  });

  it("--tag 必須オプションが無いとエラーになる", async () => {
    const { stderr, code } = await runCli(
      ["build", "-f", path.join(FIXTURE_DIR, "Agentfile.yaml")],
      { EASYFLOW_STORE_DIR: storeDir },
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/required option|必須/i);
  });

  it("正常ビルドで exit 0 が返り、ストアに保存される", async () => {
    const ref = "estack-inc/build-fixture-cli:1.0.0";
    const { stdout, stderr, code } = await runCli(
      ["--no-color", "build", "-f", path.join(FIXTURE_DIR, "Agentfile.yaml"), "-t", ref],
      { EASYFLOW_STORE_DIR: storeDir },
    );
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain("Successfully built");
    expect(output).toContain(ref);

    // ストアに保存されている
    const symlinkPath = path.join(
      storeDir,
      "refs",
      "estack-inc",
      "build-fixture-cli",
      "tags",
      "1.0.0",
    );
    const linkStat = await fs.lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it("--dry-run では image が保存されないメッセージが出る", async () => {
    const ref = "estack-inc/build-fixture-cli:2.0.0";
    const { stdout, stderr, code } = await runCli(
      [
        "--no-color",
        "--dry-run",
        "build",
        "-f",
        path.join(FIXTURE_DIR, "Agentfile.yaml"),
        "-t",
        ref,
      ],
      { EASYFLOW_STORE_DIR: storeDir },
    );
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain("Dry-run: no image saved");

    const symlinkPath = path.join(
      storeDir,
      "refs",
      "estack-inc",
      "build-fixture-cli",
      "tags",
      "2.0.0",
    );
    await expect(fs.lstat(symlinkPath)).rejects.toThrow();
  });
});
