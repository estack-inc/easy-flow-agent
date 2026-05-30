/**
 * Gemini API client
 *
 * - Gemini 2.5 Flash + 2.5 Flash Lite を呼び出す
 * - contracts.md §12.1 の secret 解決順序を実装：
 *     1. provider secret `google` （ctx.resolveApiKeyForProvider("google")）
 *     2. runtime env GEMINI_API_KEY
 *     3. 両方未設定なら明示的失敗
 * - Gemini が返す JSON を parse し、validation 後に AnalyzeTranscriptResponse 形式に整形
 * - 失敗は GeminiFailureKind の 4 種に分類して throw
 * - **Sonnet 全文 fallback は実装しない**（fallbackModel も Gemini 系のみ）
 */
import { type GeminiFailureKind } from "./types.js";
export interface GeminiAuthContext {
    /** OpenClaw の provider secret API。未提供時は env fallback */
    resolveApiKeyForProvider?: (provider: string) => string | undefined | Promise<string | undefined>;
}
export interface GeminiClientOptions {
    /** 主モデル名（例：'gemini-2.5-flash'） */
    model: string;
    /** timeout（秒） */
    timeoutSec: number;
    /** auth ctx（OpenClaw provider secret 解決経路） */
    authContext?: GeminiAuthContext;
}
export declare class GeminiAuthMissingError extends Error {
    constructor();
}
export declare class GeminiCallError extends Error {
    readonly kind: GeminiFailureKind;
    constructor(kind: GeminiFailureKind, message: string);
}
export interface GeminiAnalyzeResult {
    /** Gemini が返した raw JSON 文字列（後段で parse） */
    rawJson: string;
    /** plugin 観測値（USD） */
    costUsd: number;
    /** 使った model 名 */
    model: string;
}
/**
 * Gemini API client。OpenClaw plugin 内で 1 個生成して共有する。
 */
export declare class GeminiClient {
    private readonly options;
    constructor(options: GeminiClientOptions);
    /**
     * API key を解決する。
     *
     * 順序：
     * 1. authContext.resolveApiKeyForProvider("google")
     * 2. process.env.GEMINI_API_KEY
     * 3. 両方無ければ throw GeminiAuthMissingError
     */
    resolveApiKey(): Promise<string>;
    /**
     * Gemini 2.5 Flash に prompt を送り、JSON 応答を取得する。
     *
     * 失敗は kind 別に GeminiCallError で throw する：
     * - "429"        rate limit
     * - "500"        server error
     * - "timeout"    timeout（geminiTimeoutSec 超過）
     * - "auth_missing" api key 未設定
     *
     * @param prompt - 送信する prompt（buildAnalyzePrompt で組み立て済み）
     * @param modelOverride - 主モデルではなく fallbackModel 等を使いたい場合に指定
     */
    generateContent(prompt: string, modelOverride?: string): Promise<GeminiAnalyzeResult>;
}
/**
 * Gemini API error の kind 推定（status code / message から）
 */
export declare function classifyGeminiError(err: unknown): GeminiFailureKind;
