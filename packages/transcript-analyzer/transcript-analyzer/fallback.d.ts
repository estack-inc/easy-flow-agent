/**
 * 多段 fallback 経路
 *
 * 順序（contracts.md §7.3）：
 *   1. cache hit                 → 即返却（caller 側で実施。本ファイルは Gemini 経路のみ扱う）
 *   2. Gemini 2.5 Flash 全文      → 成功なら "miss" を返す
 *   3. chunk 分割再試行           → 成功なら "fallback_chunk"
 *   4. fallbackModel              → 成功なら "fallback_model"（モデルは Gemini 系のみ。Sonnet 禁止）
 *   5. 全段失敗                   → "failure" を返却（answer は明示メッセージ）
 *
 * 重要：Sonnet 全文 fallback は実装しない。本ファイルでも明示的に
 * 「primaryModel / fallbackModel が gemini- 系であること」を確認する。
 */
import { type GeminiClient } from "./gemini-client.js";
import { type CacheStatus, type GeminiFailureKind } from "./types.js";
export interface FallbackOptions {
    /** 主モデル（例：gemini-2.5-flash） */
    primaryModel: string;
    /** fallback model（gemini- 系のみ。Sonnet / claude 禁止） */
    fallbackModel: string;
    /** chunk 分割時の 1 chunk の最大文字数 */
    chunkMaxChars?: number;
}
export interface FallbackResult {
    /** Gemini 応答の raw JSON */
    rawJson: string;
    /** 使った model 名 */
    model: string;
    /** 観測値 */
    costUsd: number;
    /** 経路結果 */
    cacheStatus: Extract<CacheStatus, "miss" | "fallback_chunk" | "fallback_model" | "failure">;
    /** Gemini 失敗の経路を warnings へ流す用 */
    warnings: string[];
    /** failure 時に caller が messages に明示するための kind */
    lastFailureKind?: GeminiFailureKind;
}
/**
 * Gemini fallback 経路を実行する。
 *
 * Sonnet 全文 fallback は呼ばない。primaryModel / fallbackModel が
 * gemini- 系でないことを runtime check で弾く。
 */
export declare function runWithFallback(client: GeminiClient, transcriptContent: string, userQuery: string, options: FallbackOptions): Promise<FallbackResult>;
/**
 * transcript を chunk_max_chars で分割する。境界は改行優先で寄せる。
 */
export declare function splitIntoChunks(content: string, chunkMaxChars: number): string[];
//# sourceMappingURL=fallback.d.ts.map