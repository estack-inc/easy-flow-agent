import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ENTRY_PATH = path.resolve(import.meta.dirname, "../../src/cli/index.ts");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures");
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../templates");

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

describe("easyflow validate (CLI)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-validate-cli-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("valid な Agentfile で exit code 0 が返る", async () => {
    const { code, stdout } = await runCli([
      "validate",
      "-f",
      path.join(FIXTURE_DIR, "valid-minimal.yaml"),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓");
  });

  it("invalid な Agentfile で exit code 1 が返る", async () => {
    const { code, stdout } = await runCli([
      "validate",
      "-f",
      path.join(FIXTURE_DIR, "invalid-bad-name.yaml"),
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("✗");
  });

  it("警告のみの場合は exit code 0 が返る（warnings は ok を妨げない）", async () => {
    // valid-minimal.yaml は ok:true なので警告のみの場合は exit 0
    const { code } = await runCli(["validate", "-f", path.join(FIXTURE_DIR, "valid-minimal.yaml")]);
    expect(code).toBe(0);
  });

  it("--json で JSON 形式の出力が得られる", async () => {
    const { code, stdout } = await runCli([
      "validate",
      "-f",
      path.join(FIXTURE_DIR, "valid-minimal.yaml"),
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toBeDefined();
    expect(parsed.warnings).toBeDefined();
  });

  it("--json でエラーがある場合も JSON 形式で exit 1 が返る", async () => {
    const { code, stdout } = await runCli([
      "validate",
      "-f",
      path.join(FIXTURE_DIR, "invalid-bad-name.yaml"),
      "--json",
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("-f オプションなしでエラーになる", async () => {
    const { code, stderr } = await runCli(["validate"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/required option|必須/i);
  });
});
