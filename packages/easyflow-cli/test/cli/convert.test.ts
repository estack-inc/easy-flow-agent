import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = resolve(__dirname, "../../src/cli/index.ts");
const SAMPLE_TEMPLATE_DIR = resolve(__dirname, "../fixtures/convert/sample-template");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

describe("easyflow convert", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "easyflow-convert-cli-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("--template 指定なしでエラー終了", async () => {
    const { stderr, code } = await runCli(["convert"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/required option|--template/);
  });

  it("--output 指定時に YAML が書き出される", async () => {
    const outputPath = join(workDir, "out.yaml");
    const { stderr, code } = await runCli([
      "convert",
      "--template",
      "sample",
      "--source",
      SAMPLE_TEMPLATE_DIR,
      "--output",
      outputPath,
    ]);

    expect(code).toBe(0);
    expect(stderr).toContain("Converted 'sample' template");
    expect(stderr).toContain("Output:");

    const fileContent = readFileSync(outputPath, "utf-8");
    const parsed = yaml.load(fileContent) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe("easyflow/v1");
    expect(parsed.kind).toBe("Agent");
  });

  it("--output 省略時は stdout に YAML、stderr にサマリ", async () => {
    const { stdout, stderr, code } = await runCli([
      "convert",
      "--template",
      "sample",
      "--source",
      SAMPLE_TEMPLATE_DIR,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("apiVersion: ");
    expect(stderr).toContain("Converted 'sample' template");
    expect(stderr).toContain("Output: <stdout>");
  });

  it("--no-color + stdout 出力時に YAML へ進捗ログが混入しない", async () => {
    const { stdout, stderr, code } = await runCli([
      "--no-color",
      "convert",
      "--template",
      "sample",
      "--source",
      SAMPLE_TEMPLATE_DIR,
    ]);

    expect(code).toBe(0);
    // YAML だけを jsyaml に食わせてパース可能であること（進捗ログが混入すると破綻する）
    const parsed = yaml.load(stdout) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe("easyflow/v1");
    expect(parsed.kind).toBe("Agent");
    // 進捗ログは stderr 側に出ている
    expect(stderr).toMatch(/\d+\/\d+ /);
  });

  it("--template infra で明示的に変換対象外メッセージを返す", async () => {
    const { stderr, code } = await runCli(["convert", "--template", "infra"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("infra は Agentfile 変換の対象外です");
  });

  it("既定パス解決失敗時はガイダンス付き EasyflowError", async () => {
    const { stderr, code } = await runCli(["convert", "--template", "nonexistent"], {
      OPENCLAW_TEMPLATES_DIR: "",
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/変換元テンプレートディレクトリ|--source/);
  });

  it("OPENCLAW_TEMPLATES_DIR を用いたパス解決が動く (env/templates/<name>)", async () => {
    const outputPath = join(workDir, "env.yaml");
    // openclaw-templates の実レイアウト (<root>/templates/<name>/) を再現
    const envRoot = join(workDir, "env-root");
    mkdirSync(join(envRoot, "templates"), { recursive: true });
    symlinkSync(SAMPLE_TEMPLATE_DIR, join(envRoot, "templates", "sample-template"));

    const { stderr, code } = await runCli(
      ["convert", "--template", "sample-template", "--output", outputPath],
      { OPENCLAW_TEMPLATES_DIR: envRoot },
    );

    expect(code).toBe(0);
    expect(stderr).toContain("Converted 'sample-template' template");
  });
});
