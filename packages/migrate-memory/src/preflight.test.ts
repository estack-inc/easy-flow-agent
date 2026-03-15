import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight, validateExcludePatterns } from "./preflight.js";

describe("runPreflight", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects GitHub PAT and does not record the value", async () => {
    const file = path.join(tmpDir, "secrets.md");
    fs.writeFileSync(
      file,
      "# Config\n\ntoken: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n\nmore lines\nline5\n",
      "utf-8",
    );

    const { results, hasSecrets } = await runPreflight([file]);

    expect(hasSecrets).toBe(true);
    expect(results[0].secrets).toContain("GitHub PAT (classic)");
    // 値が含まれていないことを検証
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("detects Slack Webhook URL", async () => {
    const file = path.join(tmpDir, "webhook.md");
    fs.writeFileSync(
      file,
      "# Slack\n\nhttps://hooks.slack.com/services/T00/B00/xxxx\n\nmore\nlines\n",
      "utf-8",
    );

    const { results, hasSecrets } = await runPreflight([file]);

    expect(hasSecrets).toBe(true);
    expect(results[0].secrets).toContain("Slack Webhook URL");
  });

  it("detects GitLab PAT", async () => {
    const file = path.join(tmpDir, "gitlab.md");
    fs.writeFileSync(
      file,
      "# GitLab\n\ntoken: glpat-abcdefghij1234567890\n\nmore\nlines\n",
      "utf-8",
    );

    const { hasSecrets } = await runPreflight([file]);
    expect(hasSecrets).toBe(true);
  });

  it("detects password patterns (PW:, パスワード:, password=)", async () => {
    const file = path.join(tmpDir, "passwords.md");
    fs.writeFileSync(
      file,
      "# Auth\n\nPW: secret123\nパスワード: himitsu\npassword=abc123\nmore\nlines\n",
      "utf-8",
    );

    const { results, hasSecrets } = await runPreflight([file]);

    expect(hasSecrets).toBe(true);
    expect(results[0].secrets).toContain("PW直書き");
    expect(results[0].secrets).toContain("パスワード直書き");
    expect(results[0].secrets).toContain("password直書き");
  });

  it("returns hasSecrets: false for clean files", async () => {
    const file = path.join(tmpDir, "clean.md");
    fs.writeFileSync(
      file,
      "# Normal Document\n\nThis is a clean file.\nNo secrets here.\nJust normal content.\n",
      "utf-8",
    );

    const { results, hasSecrets } = await runPreflight([file]);

    expect(hasSecrets).toBe(false);
    expect(results[0].secrets).toHaveLength(0);
  });

  it("warns when file has fewer than 5 lines", async () => {
    const file = path.join(tmpDir, "short.md");
    fs.writeFileSync(file, "# Short\n\nOnly 3 lines.", "utf-8");

    const { results } = await runPreflight([file]);

    expect(results[0].warnings).toContain("情報密度が低く参照されにくい可能性があります");
  });

  it("warns when file has more than 200 lines", async () => {
    const file = path.join(tmpDir, "long.md");
    const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`).join("\n");
    fs.writeFileSync(file, lines, "utf-8");

    const { results } = await runPreflight([file]);

    expect(results[0].warnings).toContain(
      "チャンク分割で文脈が切れる可能性があります。ファイル分割を推奨します",
    );
  });

  it("does not duplicate pattern names for multiple matches", async () => {
    const file = path.join(tmpDir, "multi.md");
    fs.writeFileSync(file, "PW: abc\nPW: def\nPW: ghi\nmore\nlines\n", "utf-8");

    const { results } = await runPreflight([file]);

    const pwCount = results[0].secrets.filter((s) => s === "PW直書き").length;
    expect(pwCount).toBe(1);
  });

  it("handles file read errors gracefully", async () => {
    const nonExistent = path.join(tmpDir, "does-not-exist.md");

    const { results, hasSecrets } = await runPreflight([nonExistent]);

    expect(hasSecrets).toBe(false);
    expect(results[0].warnings).toHaveLength(1);
    expect(results[0].warnings[0]).toContain("ファイル読み取りエラー");
  });

  it("handles multiple files independently", async () => {
    const clean = path.join(tmpDir, "clean.md");
    const dirty = path.join(tmpDir, "dirty.md");
    fs.writeFileSync(clean, "# Clean\n\nNo issues\nhere\nat all\n", "utf-8");
    fs.writeFileSync(
      dirty,
      "# Dirty\n\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\nmore\nlines\n",
      "utf-8",
    );

    const { results, hasSecrets } = await runPreflight([clean, dirty]);

    expect(hasSecrets).toBe(true);
    expect(results[0].secrets).toHaveLength(0);
    expect(results[1].secrets).toContain("GitHub PAT (classic)");
  });
});

describe("validateExcludePatterns", () => {
  it("warns when excludePattern lacks **/ prefix", () => {
    const warnings = validateExcludePatterns(["bank-accounts.md", "*.secret.md"]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("bank-accounts.md");
    expect(warnings[1]).toContain("*.secret.md");
  });

  it("does not warn for patterns with **/ prefix", () => {
    const warnings = validateExcludePatterns(["**/bank-accounts.md", "/absolute/path.md"]);

    expect(warnings).toHaveLength(0);
  });

  it("does not warn for absolute paths", () => {
    const warnings = validateExcludePatterns(["/Users/test/secret.md"]);

    expect(warnings).toHaveLength(0);
  });
});
