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

import { GoogleGenerativeAI } from "@google/generative-ai";
import { assertNotForbiddenModel, type GeminiFailureKind } from "./types.js";

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

export class GeminiAuthMissingError extends Error {
  constructor() {
    super(
      "[transcript-analyzer] API key missing: neither provider secret 'google' nor GEMINI_API_KEY is set",
    );
    this.name = "GeminiAuthMissingError";
  }
}

export class GeminiCallError extends Error {
  constructor(
    public readonly kind: GeminiFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "GeminiCallError";
  }
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
export class GeminiClient {
  constructor(private readonly options: GeminiClientOptions) {
    // 起動時に forbidden model token を弾く（runtime guard）
    assertNotForbiddenModel(options.model);
  }

  /**
   * API key を解決する。
   *
   * 順序：
   * 1. authContext.resolveApiKeyForProvider("google")
   * 2. process.env.GEMINI_API_KEY
   * 3. 両方無ければ throw GeminiAuthMissingError
   */
  async resolveApiKey(): Promise<string> {
    const ctx = this.options.authContext;
    if (ctx?.resolveApiKeyForProvider) {
      try {
        const v = await ctx.resolveApiKeyForProvider("google");
        if (typeof v === "string" && v.length > 0) return v;
      } catch {
        // provider secret 解決失敗時は env fallback に進む
      }
    }
    const envKey = process.env.GEMINI_API_KEY;
    if (typeof envKey === "string" && envKey.length > 0) return envKey;
    throw new GeminiAuthMissingError();
  }

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
  async generateContent(prompt: string, modelOverride?: string): Promise<GeminiAnalyzeResult> {
    const apiKey = await this.resolveApiKey();
    const modelName = modelOverride ?? this.options.model;
    assertNotForbiddenModel(modelName);

    const sdk = new GoogleGenerativeAI(apiKey);
    const model = sdk.getGenerativeModel({ model: modelName });

    // timeout を Promise.race で実装
    const timeoutMs = Math.max(1, this.options.timeoutSec * 1000);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new GeminiCallError("timeout", `Gemini ${modelName} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    try {
      const callPromise = model.generateContent(prompt).then((res) => {
        // SDK は { response: { text(): string, usageMetadata?: { totalTokenCount } } } を返す
        const text =
          typeof res?.response?.text === "function" ? res.response.text() : String(res ?? "");
        const usage = res?.response?.usageMetadata;
        const totalTokens =
          (usage as { totalTokenCount?: number } | undefined)?.totalTokenCount ?? 0;
        return { text, totalTokens };
      });

      const result = await Promise.race([callPromise, timeoutPromise]);
      const costUsd = estimateCostUsd(modelName, result.totalTokens);
      return {
        rawJson: result.text,
        costUsd,
        model: modelName,
      };
    } catch (err) {
      if (err instanceof GeminiCallError) throw err;
      const kind = classifyGeminiError(err);
      const message = err instanceof Error ? err.message : String(err);
      throw new GeminiCallError(kind, `Gemini ${modelName} ${kind} error: ${message}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Gemini API error の kind 推定（status code / message から）
 */
export function classifyGeminiError(err: unknown): GeminiFailureKind {
  const message =
    typeof err === "object" && err !== null
      ? `${(err as { status?: number }).status ?? ""} ${(err as Error).message ?? ""}`.trim()
      : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota"))
    return "429";
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted"))
    return "timeout";
  if (lower.includes("auth") && lower.includes("missing")) return "auth_missing";
  // 5xx / 4xx unknown は 500 として扱う
  return "500";
}

/**
 * Gemini API spend のおおまかな見積もり（USD）
 *
 * 2026-05 時点：
 * - gemini-2.5-flash:        input  $0.075/1M tokens, output $0.30/1M tokens
 * - gemini-1.5-flash:        input  $0.075/1M tokens, output $0.30/1M tokens
 *   (fallback も同価格帯のため簡易合算で十分)
 *
 * 厳密な input / output 分割は usageMetadata から取れる場合のみ可能だが、
 * plugin 側では totalTokenCount しか取れないため、平均価格で概算する。
 */
function estimateCostUsd(model: string, totalTokens: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  // input:output = 4:1 を仮定し、平均単価 = (0.075 * 0.8 + 0.30 * 0.2) = $0.12/1M tokens
  // model 別の細かい差異は Phase 2 で対応。Phase 1 は近似で十分。
  const pricePerMillion =
    model.startsWith("gemini-2.5") || model.startsWith("gemini-1.5") ? 0.12 : 0.15;
  return (totalTokens / 1_000_000) * pricePerMillion;
}
