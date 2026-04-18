import type { InspectReport } from "./types.js";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * InspectReport を人間向けテキスト形式にフォーマットする。
 */
export function formatHuman(report: InspectReport): string {
  const lines: string[] = [];

  lines.push("=== Image ===");
  lines.push(`  Ref:       ${report.ref}`);
  lines.push(`  Digest:    ${report.digest}`);
  lines.push(`  Size:      ${formatBytes(report.size)}`);
  lines.push(`  CreatedAt: ${report.createdAt}`);
  lines.push("");

  lines.push("=== Metadata ===");
  lines.push(`  Name:        ${report.metadata.name}`);
  lines.push(`  Version:     ${report.metadata.version}`);
  lines.push(`  Description: ${report.metadata.description}`);
  lines.push(`  Author:      ${report.metadata.author}`);
  if (report.metadata.base) {
    lines.push(
      `  Base:        ${report.metadata.base.ref}${report.metadata.base.digest ? ` (${report.metadata.base.digest})` : ""}`,
    );
  }
  lines.push("");

  lines.push("=== Identity ===");
  lines.push(`  Name:        ${report.identity.name}`);
  lines.push(`  Soul:        ${report.identity.soulPreview}`);
  lines.push(`  Policies:    ${report.identity.policyCount}`);
  lines.push("");

  lines.push("=== Knowledge ===");
  lines.push(`  Total Chunks: ${report.knowledge.totalChunks}`);
  lines.push(`  Total Tokens: ${report.knowledge.totalTokens}`);
  if (report.knowledge.sources.length > 0) {
    lines.push("  Sources:");
    for (const src of report.knowledge.sources) {
      lines.push(`    - ${src.path} [${src.type}] chunks=${src.chunks} tokens=${src.tokens}`);
    }
  } else {
    lines.push("  Sources: (none)");
  }
  lines.push("");

  lines.push("=== Tools ===");
  if (report.tools.length > 0) {
    for (const tool of report.tools) {
      lines.push(`  - ${tool}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  lines.push("=== Channels ===");
  if (report.channels.length > 0) {
    for (const ch of report.channels) {
      lines.push(`  - ${ch}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  lines.push("=== Layers ===");
  for (const layer of report.layers) {
    lines.push(
      `  ${layer.name.padEnd(10)} ${formatBytes(layer.size).padStart(8)}  files=${layer.fileCount}  ${layer.digest}`,
    );
  }

  return lines.join("\n");
}

/**
 * InspectReport を JSON 形式にフォーマットする。
 */
export function formatJson(report: InspectReport): string {
  return JSON.stringify(report, null, 2);
}
