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
};

export const DEFAULT_CONFIG: Required<ModelRouterConfig> = {
  defaultModel: "claude-sonnet-4-6",
  defaultProvider: "anthropic",
  lightModel: "claude-haiku-4-5",
  lightProvider: "anthropic",
  maxTokensForLight: 100,
  patterns: {
    forceDefault: [
      "レビュー", "設計", "分析", "調査", "コード", "実装",
      "デプロイ", "修正", "バグ", "エラー", "仕様",
    ],
    preferLight: [
      "おはよう", "こんにちは", "おやすみ", "ありがとう",
      "了解", "OK", "ok", "わかった", "確認", "はい", "いいえ",
    ],
  },
  logging: true,
};
