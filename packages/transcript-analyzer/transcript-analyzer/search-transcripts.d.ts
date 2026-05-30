/**
 * T2: transcript-analyzer.search_transcripts
 *
 * query に関連する transcript chunk を BM25 風スコアで top-k 返す。
 * Phase 1 は keyword 一致ベース（structured search の代用）の実装。
 * Phase 2 で pgvector embedding 検索に置き換え予定。
 *
 * 引数：SearchTranscriptsRequest { query, top_k? }
 * 戻り値：SearchTranscriptsResponse { chunks: TranscriptChunk[], total_found }
 *
 * Phase 1 設計：
 * - transcriptDir 配下を chunk size 512 byte で分割
 * - query を normalize して tokenize（空白区切り）
 * - 各 chunk の token 一致数 / chunk 長で score 算出
 * - score desc で top_k（既定 10）
 */
import type { SearchTranscriptsRequest, SearchTranscriptsResponse } from "./types.js";
export interface SearchTranscriptsDeps {
    transcriptDir: string;
}
/**
 * search_transcripts 実装。
 *
 * Phase 1 は file 走査ベースの単純検索。Phase 2 で pgvector embedding 検索に置換。
 */
export declare function searchTranscripts(req: SearchTranscriptsRequest, deps: SearchTranscriptsDeps): Promise<SearchTranscriptsResponse>;
//# sourceMappingURL=search-transcripts.d.ts.map