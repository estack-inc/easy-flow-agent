import type { ModelRouterConfig } from "./config.js";

export type ClassificationResult = "light" | "default";

/**
 * ユーザープロンプトを分類し、軽量モデルで処理可能かを判定する。
 *
 * 判定優先順位:
 * 1. forceDefault パターンに一致 → "default"（Sonnet 維持）
 * 2. トークン数超過 → "default"
 * 3. preferLight パターンに一致 → "light"（Haiku）
 * 4. いずれにも該当しない → "default"
 */
export function classifyMessage(
  prompt: string,
  config: Required<ModelRouterConfig>,
): ClassificationResult {
  // 1. forceDefault パターンに一致する場合は Sonnet 維持
  const forceDefaultPatterns = config.patterns.forceDefault ?? [];
  if (forceDefaultPatterns.some((p) => prompt.includes(p))) {
    return "default";
  }

  // 2. トークン数チェック（簡易近似: 文字数 / 3）
  const estimatedTokens = Math.ceil(prompt.length / 3);
  if (estimatedTokens > config.maxTokensForLight) {
    return "default";
  }

  // 3. preferLight パターンに一致する場合は Haiku
  const preferLightPatterns = config.patterns.preferLight ?? [];
  if (
    preferLightPatterns.some((p) =>
      prompt.toLowerCase().includes(p.toLowerCase()),
    )
  ) {
    return "light";
  }

  // 4. デフォルトは Sonnet 維持
  return "default";
}
