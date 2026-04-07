export type ModelRouterConfig = {
  defaultModel?: string;
  defaultProvider?: string;
  lightModel?: string;
  lightProvider?: string;
  maxTokensForLight?: number;
  patterns?: {
    forceDefault?: string[];
    preferLight?: string[];
  };
  logging?: boolean;
  /** セッションコンテキストによる Sticky Default Guard の有効/無効 */
  enableSessionContext?: boolean;
  /** Sticky Default Guard が参照する直近ターン数 */
  stickyWindowSize?: number;
  /** セッション TTL（ミリ秒）。超過したセッションは自動削除 */
  sessionTtlMs?: number;
  /** インメモリに保持する最大セッション数 */
  maxSessions?: number;
};

export const DEFAULT_CONFIG: Required<ModelRouterConfig> = {
  defaultModel: "claude-sonnet-4-6",
  defaultProvider: "anthropic",
  lightModel: "claude-haiku-4-5",
  lightProvider: "anthropic",
  maxTokensForLight: 100,
  patterns: {
    forceDefault: [
      // 日本語
      "レビュー",
      "設計",
      "分析",
      "調査",
      "コード",
      "実装",
      "デプロイ",
      "修正",
      "バグ",
      "エラー",
      "仕様",
      // 英語（preferLight の英語キーワードとの誤分類を防ぐため）
      "review",
      "code",
      "bug",
      "error",
      "analyze",
      "implement",
      "deploy",
      "fix",
      "design",
    ],
    preferLight: [
      "おはよう",
      "こんにちは",
      "おやすみ",
      "ありがとう",
      "了解",
      "ok",
      "わかった",
      "はい",
      "いいえ",
    ],
  },
  logging: true,
  enableSessionContext: true,
  stickyWindowSize: 3,
  sessionTtlMs: 30 * 60 * 1000, // 30 分
  maxSessions: 1000,
};
