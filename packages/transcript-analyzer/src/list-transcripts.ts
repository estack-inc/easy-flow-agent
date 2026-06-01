/**
 * T1: transcript_analyzer_list_transcripts
 *
 * transcriptDir 配下のファイル一覧を返す。
 * 機密 metadata（participant / meeting_name 等）は redact 済み summary_excerpt のみ含める。
 *
 * 引数：なし
 * 戻り値：ListTranscriptsResponse
 *
 * contracts.md §1.3 の TranscriptMetadata field：
 *   { id, size_bytes, modified_at, summary_excerpt_redacted }
 *
 * id は file_hash の prefix（16 文字）。これにより list / search / analyze で
 * 同一 transcript を一意に識別できる。
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { computeFileHash } from "./cache.js";
import { redactForListSummary } from "./redaction.js";
import type { ListTranscriptsResponse, TranscriptMetadata } from "./types.js";

export interface ListTranscriptsDeps {
  transcriptDir: string;
}

/**
 * list_transcripts 実装。transcriptDir を走査して機密 metadata を redact 済み形式で返す。
 *
 * - 隠しファイル（'.' 開始）は除外
 * - サブディレクトリは非走査（Phase 1 は flat 構造のみ）
 * - 並び順：modified_at desc（新しいファイルを先頭）
 */
export async function listTranscripts(deps: ListTranscriptsDeps): Promise<ListTranscriptsResponse> {
  const transcripts: TranscriptMetadata[] = [];

  let entries: string[];
  let transcriptDirRealPath: string;
  try {
    entries = readdirSync(deps.transcriptDir, { withFileTypes: false }) as string[];
    transcriptDirRealPath = realpathSync(deps.transcriptDir);
  } catch {
    // ディレクトリが存在しない / 読めない場合は空配列を返す（block にはしない）
    return { transcripts: [] };
  }

  for (const name of entries) {
    if (typeof name !== "string") continue;
    if (name.startsWith(".")) continue;
    const fullPath = join(deps.transcriptDir, name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      if (!isWithinDirectory(realpathSync(fullPath), transcriptDirRealPath)) continue;
    } catch {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      // 読めないファイルは skip
      continue;
    }

    const fileHash = computeFileHash(content);
    const id = fileHash.slice(0, 16);

    // summary_excerpt は先頭 240 文字（redactForListSummary で 80 文字に truncate される）
    const head = content.slice(0, 240);
    const summaryRedacted = redactForListSummary(head);

    transcripts.push({
      id,
      size_bytes: stats.size,
      modified_at: new Date(stats.mtimeMs).toISOString(),
      summary_excerpt_redacted: summaryRedacted,
    });
  }

  transcripts.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
  return { transcripts };
}

function isWithinDirectory(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
