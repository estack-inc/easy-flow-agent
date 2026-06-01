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
import type { ListTranscriptsResponse } from "./types.js";
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
export declare function listTranscripts(deps: ListTranscriptsDeps): Promise<ListTranscriptsResponse>;
