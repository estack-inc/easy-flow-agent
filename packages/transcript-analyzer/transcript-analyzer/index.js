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
import { join } from "node:path";
import { analyzeTranscript } from "./analyze-transcript.js";
import { CACHE_NAMESPACE, CacheStore, FileCacheBackend } from "./cache.js";
import { GeminiClient } from "./gemini-client.js";
import { listTranscripts } from "./list-transcripts.js";
import { QuotaStore } from "./quota.js";
import { searchTranscripts } from "./search-transcripts.js";
import { assertAllowedGeminiModel } from "./types.js";
export { analyzeTranscript } from "./analyze-transcript.js";
// public API として再 export
export { CacheStore, FileCacheBackend, InMemoryCacheBackend } from "./cache.js";
export { runWithFallback, splitIntoChunks } from "./fallback.js";
export { GeminiAuthMissingError, GeminiCallError, GeminiClient } from "./gemini-client.js";
export { listTranscripts } from "./list-transcripts.js";
export { buildAnalyzePrompt, detectPromptInjection, isCitationByteRangeValid, } from "./prompt-injection-guard.js";
export { QuotaStore } from "./quota.js";
export { applyExcerptLimits, MAX_EXCERPT_CHARS_PER_CITATION, MAX_TOTAL_EXCERPT_CHARS, redactForListSummary, redactSensitive, } from "./redaction.js";
export { searchTranscripts } from "./search-transcripts.js";
const TAG = "[transcript-analyzer]";
// ----------------------------------------------------------------------------
// 既定値（contracts.md §9.2）
// ----------------------------------------------------------------------------
const DEFAULTS = {
    transcriptDir: "/data/workspace/zoom_transcribe/",
    model: "gemini-2.5-flash",
    fallbackModel: "gemini-1.5-flash",
    cacheBackend: "file",
    cacheTtlDays: 30,
    cacheFailureTtlMinutes: 5,
    maxAnalyzePerSession: 20,
    maxAnalyzePerFilePerDay: 50,
    monthlySpendCapUsd: 50,
    promptVersion: "v1",
    geminiTimeoutSec: 60,
    enabled: true,
};
export function resolveConfig(raw) {
    const safeString = (v, fallback) => typeof v === "string" && v.length > 0 ? v : fallback;
    const safeGeminiModel = (v, fallback) => {
        const model = safeString(v, fallback);
        try {
            assertAllowedGeminiModel(model);
            return model;
        }
        catch {
            return fallback;
        }
    };
    const safeNumber = (v, fallback) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
    return {
        transcriptDir: safeString(raw.transcriptDir, DEFAULTS.transcriptDir),
        model: safeGeminiModel(raw.model, DEFAULTS.model),
        fallbackModel: safeGeminiModel(raw.fallbackModel, DEFAULTS.fallbackModel),
        cacheBackend: raw.cacheBackend === "file" ? raw.cacheBackend : DEFAULTS.cacheBackend,
        cacheTtlDays: safeNumber(raw.cacheTtlDays, DEFAULTS.cacheTtlDays),
        cacheFailureTtlMinutes: safeNumber(raw.cacheFailureTtlMinutes, DEFAULTS.cacheFailureTtlMinutes),
        maxAnalyzePerSession: safeNumber(raw.maxAnalyzePerSession, DEFAULTS.maxAnalyzePerSession),
        maxAnalyzePerFilePerDay: safeNumber(raw.maxAnalyzePerFilePerDay, DEFAULTS.maxAnalyzePerFilePerDay),
        monthlySpendCapUsd: safeNumber(raw.monthlySpendCapUsd, DEFAULTS.monthlySpendCapUsd),
        promptVersion: safeString(raw.promptVersion, DEFAULTS.promptVersion),
        geminiTimeoutSec: safeNumber(raw.geminiTimeoutSec, DEFAULTS.geminiTimeoutSec),
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    };
}
export function createCacheStore(config) {
    const baseDir = process.env.TRANSCRIPT_ANALYZER_CACHE_DIR ?? `/data/cache/${CACHE_NAMESPACE}`;
    return new CacheStore(new FileCacheBackend(baseDir), {
        ttlDays: config.cacheTtlDays,
        failureTtlMinutes: config.cacheFailureTtlMinutes,
    });
}
export function createQuotaStore() {
    const baseDir = process.env.TRANSCRIPT_ANALYZER_CACHE_DIR ?? `/data/cache/${CACHE_NAMESPACE}`;
    return new QuotaStore({ spendFilePath: join(baseDir, "quota-spend.json") });
}
function createListTranscriptsTool(deps) {
    return {
        name: "transcript-analyzer.list_transcripts",
        description: "List transcripts available under transcriptDir. Returns redacted metadata only " +
            "(no participant names, meeting names, etc. shown in clear text). " +
            "Use this before search_transcripts or analyze_transcript to discover transcript_id.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
        execute: async () => {
            try {
                const response = await listTranscripts({ transcriptDir: deps.config.transcriptDir });
                return jsonText(response);
            }
            catch (err) {
                return jsonText({
                    transcripts: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}
function createSearchTranscriptsTool(deps) {
    return {
        name: "transcript-analyzer.search_transcripts",
        description: "Search transcript chunks matching the query (BM25-like keyword scoring in Phase 1). " +
            "Returns top-k chunks with transcript_id, chunk_id, byte_range, score (0.0-1.0). " +
            "Use the returned transcript_id with analyze_transcript for deep analysis.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Free-text query to search.",
                },
                top_k: {
                    type: "number",
                    description: "Optional. Number of top chunks to return (default 10).",
                },
            },
            required: ["query"],
        },
        execute: async (_callId, args) => {
            const req = {
                query: typeof args.query === "string" ? args.query : "",
                top_k: typeof args.top_k === "number" ? args.top_k : undefined,
            };
            try {
                const response = await searchTranscripts(req, {
                    transcriptDir: deps.config.transcriptDir,
                });
                return jsonText(response);
            }
            catch (err) {
                return jsonText({
                    chunks: [],
                    total_found: 0,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}
function createAnalyzeTranscriptTool(deps, ctx) {
    return {
        name: "transcript-analyzer.analyze_transcript",
        description: "Analyze a transcript with Gemini 2.5 Flash and return a structured answer with citations. " +
            "Returns AnalyzeTranscriptResponse with answer, citations[], confidence (0.0-1.0), " +
            "answer_scope ('explicit'/'inferred'/'not_found'), cache_status, and redactions. " +
            "transcript_id must be obtained from list_transcripts or search_transcripts.",
        parameters: {
            type: "object",
            properties: {
                transcript_id: {
                    type: "string",
                    description: "Transcript ID from list_transcripts.",
                },
                query: {
                    type: "string",
                    description: "User's question about the transcript.",
                },
            },
            required: ["transcript_id", "query"],
        },
        execute: async (_callId, args) => {
            const req = {
                transcript_id: typeof args.transcript_id === "string" ? args.transcript_id : "",
                query: typeof args.query === "string" ? args.query : "",
            };
            try {
                const response = await analyzeTranscript(req, {
                    config: deps.config,
                    cacheStore: deps.cacheStore,
                    quotaStore: deps.quotaStore,
                    geminiClient: deps.geminiClient,
                    sessionId: ctx.sessionId ?? "default",
                    metrics: deps.metricsIncrement,
                });
                return jsonText(response);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const failureResp = {
                    answer: "cost-guard: transcript の解析に失敗しました。後でもう一度お試しください",
                    citations: [],
                    used_chunks: [],
                    redactions: [],
                    answer_scope: "not_found",
                    confidence: 0,
                    confidence_reason: "unexpected_error",
                    model: deps.config.model,
                    cache_status: "failure",
                    prompt_version: deps.config.promptVersion,
                    warnings: [`unexpected_error:${message}`],
                    open_questions: [],
                };
                return jsonText(failureResp);
            }
        },
    };
}
function jsonText(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
    };
}
// ----------------------------------------------------------------------------
// plugin entry
// ----------------------------------------------------------------------------
const transcriptAnalyzerPlugin = {
    id: "transcript-analyzer",
    name: "Transcript Analyzer",
    kind: "plugin",
    description: "Phase 1 transcript-analyzer plugin。3 tool（list / search / analyze）と Gemini 2.5 Flash 統合、4-key cache、多段 fallback、redaction、prompt injection guard。",
    register(api) {
        const rawConfig = (api.pluginConfig ?? {});
        const config = resolveConfig(rawConfig);
        const log = api.logger;
        if (!config.enabled) {
            log.warn(`${TAG} disabled (config.enabled=false)。tool は登録されません`);
            return;
        }
        const cacheStore = createCacheStore(config);
        const quotaStore = createQuotaStore();
        const metricsIncrement = (name, labels) => {
            api.metrics?.incrementCounter?.(name, labels);
        };
        log.info(`${TAG} registered (model=${config.model}, fallbackModel=${config.fallbackModel}, ` +
            `cacheBackend=${config.cacheBackend}, ttlDays=${config.cacheTtlDays}, ` +
            `maxAnalyzePerSession=${config.maxAnalyzePerSession}, ` +
            `monthlySpendCapUsd=${config.monthlySpendCapUsd})`);
        api.registerTool((ctx) => {
            if (ctx.sandboxed)
                return null;
            // GeminiClient は ctx 依存（resolveApiKeyForProvider 経路）。
            // factory 呼び出しの都度作成し、ctx の auth 解決経路を毎回参照する。
            const geminiClient = new GeminiClient({
                model: config.model,
                timeoutSec: config.geminiTimeoutSec,
                authContext: { resolveApiKeyForProvider: ctx.resolveApiKeyForProvider },
            });
            const deps = {
                config,
                cacheStore,
                quotaStore,
                geminiClient,
                metricsIncrement,
            };
            return [
                createListTranscriptsTool(deps),
                createSearchTranscriptsTool(deps),
                createAnalyzeTranscriptTool(deps, ctx),
            ];
        }, {
            names: [
                "transcript-analyzer.list_transcripts",
                "transcript-analyzer.search_transcripts",
                "transcript-analyzer.analyze_transcript",
            ],
            optional: true,
        });
        // 起動時の auth check（warning 程度に留め、tool 呼び出し失敗時に明示）
        const envKey = process.env.GEMINI_API_KEY;
        if (!envKey || envKey.length === 0) {
            log.warn(`${TAG} GEMINI_API_KEY env not set. Provider secret 'google' is required at runtime for analyze_transcript.`);
        }
    },
};
export default transcriptAnalyzerPlugin;
// also export register for direct use (test convenience + symmetry with cost-guard)
export const register = transcriptAnalyzerPlugin.register;
//# sourceMappingURL=index.js.map