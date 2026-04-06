import type { ModelRouterConfig } from "./config.js";
import type { SessionContext } from "./session-store.js";

export type ClassificationResult = "light" | "default";

export type ClassificationReason =
  | "force_default"
  | "token_exceeded"
  | "sticky_default"
  | "light_match"
  | "unmatched";

export type ClassificationDetail = {
  result: ClassificationResult;
  reason: ClassificationReason;
};

/**
 * ユーザープロンプトを分類し、軽量モデルで処理可能かを判定する。
 *
 * 判定優先順位:
 * 1. forceDefault パターンに一致 → "default"（Sonnet 維持）
 * 2. Sticky Default Guard（直近ターンに複雑タスクがあれば default 維持）
 * 3. トークン数超過 → "default"
 * 4. preferLight パターンに一致 → "light"（Haiku）
 * 5. いずれにも該当しない → "default"
 */
export function classifyMessage(
  prompt: string,
  config: Required<ModelRouterConfig>,
  sessionContext?: SessionContext,
): ClassificationDetail {
  // 1. forceDefault パターンに一致する場合は Sonnet 維持
  if (matchesForceDefault(prompt, config)) {
    return { result: "default", reason: "force_default" };
  }

  // 2. Sticky Default Guard: 直近ターンに複雑タスクがあれば default 維持
  if (sessionContext && shouldStickyDefault(sessionContext, config.stickyWindowSize)) {
    return { result: "default", reason: "sticky_default" };
  }

  // 3. トークン数超過
  if (exceedsTokenLimit(prompt, config)) {
    return { result: "default", reason: "token_exceeded" };
  }

  // 4. preferLight パターンに一致する場合は Haiku
  if (matchesPreferLight(prompt, config)) {
    return { result: "light", reason: "light_match" };
  }

  // 5. デフォルトは Sonnet 維持
  return { result: "default", reason: "unmatched" };
}

/** forceDefault パターンのいずれかに一致するか（case-insensitive） */
function matchesForceDefault(prompt: string, config: Required<ModelRouterConfig>): boolean {
  const patterns = config.patterns.forceDefault ?? [];
  const lower = prompt.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Sticky Default Guard: 直近ターンに force_default または token_exceeded があれば true。
 * sticky_default 自体は伝播しない（無限ループ防止）。
 */
export function shouldStickyDefault(ctx: SessionContext, windowSize: number): boolean {
  const window = ctx.recentTurns.slice(-windowSize);
  return window.some((t) => t.reason === "force_default" || t.reason === "token_exceeded");
}

/**
 * トークン数の近似推定。
 * 日本語（ひらがな・カタカナ・漢字）: 1 文字 ≈ 1 トークン
 * ASCII 英数字: 1 文字 ≈ 0.25 トークン
 */
function exceedsTokenLimit(prompt: string, config: Required<ModelRouterConfig>): boolean {
  const japaneseChars = (prompt.match(/[\u3040-\u9fff\uff00-\uffef]/g) ?? []).length;
  const otherChars = prompt.length - japaneseChars;
  const estimatedTokens = Math.ceil(japaneseChars + otherChars / 4);
  return estimatedTokens > config.maxTokensForLight;
}

/** preferLight パターンのいずれかに一致するか（case-insensitive） */
function matchesPreferLight(prompt: string, config: Required<ModelRouterConfig>): boolean {
  const patterns = config.patterns.preferLight ?? [];
  const lower = prompt.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
