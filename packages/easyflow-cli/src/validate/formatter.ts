import type { ValidationReport } from "./types.js";

/**
 * ValidationReport を人間向けテキスト形式にフォーマットする。
 */
export function formatHuman(report: ValidationReport): string {
  const lines: string[] = [];

  if (report.ok) {
    lines.push(`✓ ${report.file} — OK`);
  } else {
    lines.push(
      `✗ ${report.file} — ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
    );
  }

  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of report.errors) {
      const loc = err.path ? ` [${err.path}]` : "";
      lines.push(`  [${err.category}]${loc} ${err.message}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warn of report.warnings) {
      const loc = warn.path ? ` [${warn.path}]` : "";
      lines.push(`  [${warn.category}]${loc} ${warn.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * ValidationReport を JSON 形式にフォーマットする。
 */
export function formatJson(report: ValidationReport): string {
  return JSON.stringify(report, null, 2);
}
