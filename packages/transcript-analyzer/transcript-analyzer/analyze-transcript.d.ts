/**
 * T3: transcript-analyzer.analyze_transcript
 *
 * transcript 全文を Gemini 2.5 Flash で読み込み、query に対する answer + citations を抽出する。
 *
 * 経路（contracts.md §7.3）：
 *   1. cache hit  → hit
 *   2. quota 不足 → quota_exceeded
 *   3. Gemini 2.5 Flash → miss
 *   4. chunk 分割 → fallback_chunk
 *   5. fallbackModel → fallback_model
 *   6. 全段失敗 → failure（TTL 5 分）
 *
 * 重要：
 * - Sonnet 全文 fallback は実装しない（fallback.ts で type レベルでも禁止）
 * - excerpt は redact 後に 500 文字 / 合計 2000 文字に制限
 * - prompt injection 検出は warnings に追加（block しない）
 * - citation の byte_range は post-validate（不正は warning 追加 + drop）
 */
import { type CacheStore } from "./cache.js";
import { GeminiAuthMissingError, GeminiCallError, type GeminiClient } from "./gemini-client.js";
import type { QuotaStore } from "./quota.js";
import type { AnalyzeTranscriptRequest, AnalyzeTranscriptResponse, ResolvedConfig } from "./types.js";
export interface AnalyzeTranscriptDeps {
    config: ResolvedConfig;
    cacheStore: CacheStore;
    quotaStore: QuotaStore;
    geminiClient: GeminiClient;
    sessionId: string;
    metrics?: (name: string, labels?: Record<string, string>) => void;
    now?: () => Date;
}
/**
 * analyze_transcript 実装。caller は session_id・config・dependencies を渡す。
 */
export declare function analyzeTranscript(req: AnalyzeTranscriptRequest, deps: AnalyzeTranscriptDeps): Promise<AnalyzeTranscriptResponse>;
export { GeminiAuthMissingError, GeminiCallError };
