import { describe, expect, it } from "vitest";
import { formatHuman, formatJson } from "../../src/validate/formatter.js";
import type { ValidationReport } from "../../src/validate/types.js";

function createOkReport(file = "Agentfile.yaml"): ValidationReport {
  return {
    ok: true,
    file,
    errors: [],
    warnings: [],
  };
}

function createErrorReport(file = "Agentfile.yaml"): ValidationReport {
  return {
    ok: false,
    file,
    errors: [
      { category: "schema", message: "must have required property 'soul'", path: "/identity" },
      {
        category: "file-missing",
        message: "File not found: ./missing.md",
        path: "/knowledge/sources/0/path",
      },
    ],
    warnings: [{ category: "other", message: "deprecated field detected" }],
  };
}

describe("formatHuman (ValidationReport)", () => {
  it("OK レポートで ✓ マークを含む", () => {
    const output = formatHuman(createOkReport());
    expect(output).toContain("✓");
    expect(output).toContain("OK");
  });

  it("OK レポートにファイル名が含まれる", () => {
    const output = formatHuman(createOkReport("my/Agentfile.yaml"));
    expect(output).toContain("my/Agentfile.yaml");
  });

  it("エラーレポートで ✗ マークを含む", () => {
    const output = formatHuman(createErrorReport());
    expect(output).toContain("✗");
  });

  it("エラーレポートにエラー数が含まれる", () => {
    const output = formatHuman(createErrorReport());
    expect(output).toContain("2 error(s)");
  });

  it("エラーレポートにカテゴリが含まれる", () => {
    const output = formatHuman(createErrorReport());
    expect(output).toContain("[schema]");
    expect(output).toContain("[file-missing]");
  });

  it("エラーレポートにエラーメッセージが含まれる", () => {
    const output = formatHuman(createErrorReport());
    expect(output).toContain("must have required property 'soul'");
    expect(output).toContain("File not found: ./missing.md");
  });

  it("警告がある場合 Warnings セクションを含む", () => {
    const output = formatHuman(createErrorReport());
    expect(output).toContain("Warnings:");
    expect(output).toContain("deprecated field detected");
  });

  it("警告がない OK レポートには Warnings セクションを含まない", () => {
    const output = formatHuman(createOkReport());
    expect(output).not.toContain("Warnings:");
  });
});

describe("formatJson (ValidationReport)", () => {
  it("有効な JSON 文字列を返す", () => {
    expect(() => JSON.parse(formatJson(createOkReport()))).not.toThrow();
    expect(() => JSON.parse(formatJson(createErrorReport()))).not.toThrow();
  });

  it("OK レポートの JSON が ValidationReport と等価", () => {
    const report = createOkReport();
    const parsed = JSON.parse(formatJson(report));
    expect(parsed).toEqual(report);
  });

  it("エラーレポートの JSON が ValidationReport と等価", () => {
    const report = createErrorReport();
    const parsed = JSON.parse(formatJson(report));
    expect(parsed).toEqual(report);
  });
});
