/**
 * transcript-analyzer plugin entry point
 *
 * 役割：
 *  1. pluginConfig + 環境変数から ResolvedConfig を解決
 *  2. CacheStore / QuotaStore / GeminiClient を 1 個ずつ生成
 *  3. 3 tool（list_transcripts / search_transcripts / analyze_transcript）を registerTool で公開
 *
 * 設計判断（portal-notify-tool の pattern に合わせる）：
 *  - openclaw plugin SDK は optional peerDep。本パッケージは tsc / vitest を openclaw 未インストール
 *    環境でも通したいので、構造的型（PluginApiLike）で必要分のみ受ける
 *  - GEMINI_API_KEY 未設定でも plugin load 自体は失敗しない。tool 呼び出し時に明示的失敗で返す
 *
 * Sonnet 全文 fallback は実装しない。fallback.ts / gemini-client.ts で
 * forbidden model token を runtime check で弾いている。
 */
import { CacheStore } from "./cache.js";
import { QuotaStore } from "./quota.js";
import type { AnalyzeTranscriptRequest, AnalyzeTranscriptResponse, ListTranscriptsResponse, ResolvedConfig, SearchTranscriptsRequest, SearchTranscriptsResponse, TranscriptAnalyzerConfig } from "./types.js";
export { analyzeTranscript } from "./analyze-transcript.js";
export { CacheStore, FileCacheBackend, InMemoryCacheBackend } from "./cache.js";
export { runWithFallback, splitIntoChunks } from "./fallback.js";
export { GeminiAuthMissingError, GeminiCallError, GeminiClient } from "./gemini-client.js";
export { listTranscripts } from "./list-transcripts.js";
export { buildAnalyzePrompt, detectPromptInjection, isCitationByteRangeValid, } from "./prompt-injection-guard.js";
export { QuotaStore } from "./quota.js";
export { applyExcerptLimits, MAX_EXCERPT_CHARS_PER_CITATION, MAX_TOTAL_EXCERPT_CHARS, redactForListSummary, redactSensitive, } from "./redaction.js";
export { searchTranscripts } from "./search-transcripts.js";
export type * from "./types.js";
export declare function resolveConfig(raw: TranscriptAnalyzerConfig): ResolvedConfig;
interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, ...rest: unknown[]): void;
}
interface PluginMetrics {
    incrementCounter?(name: string, labels?: Record<string, string>): void;
    setGauge?(name: string, value: number, labels?: Record<string, string>): void;
}
interface PluginContextLike {
    /** OpenClaw provider secret 解決 API */
    resolveApiKeyForProvider?: (provider: string) => string | undefined | Promise<string | undefined>;
    /** session_id を取得（OpenClaw は ctx.sessionId 等で渡す） */
    sessionId?: string;
    sandboxed?: boolean;
}
interface AgentToolLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (callId: string, args: Record<string, unknown>) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
    }>;
}
interface PluginApiLike {
    pluginConfig?: unknown;
    logger: PluginLogger;
    metrics?: PluginMetrics;
    registerTool: (factory: (ctx: PluginContextLike) => AgentToolLike[] | null, options: {
        names: string[];
        optional?: boolean;
    }) => void;
}
export declare function createCacheStore(config: ResolvedConfig): CacheStore;
export declare function createQuotaStore(): QuotaStore;
declare const transcriptAnalyzerPlugin: {
    id: string;
    name: string;
    kind: "plugin";
    description: string;
    register(api: PluginApiLike): void;
};
export default transcriptAnalyzerPlugin;
export declare const register: (api: PluginApiLike) => void;
export type { AnalyzeTranscriptRequest, AnalyzeTranscriptResponse, ListTranscriptsResponse, SearchTranscriptsRequest, SearchTranscriptsResponse, };
//# sourceMappingURL=index.d.ts.map