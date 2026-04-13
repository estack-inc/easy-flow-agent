/** MIME pattern matching rule for file-based model routing. */
export type FileRoutingRule = {
  /** Human-readable label for logging. */
  label: string;
  /** MIME type patterns to match (supports trailing wildcard: "image/*"). */
  mimePatterns: string[];
  /** Model to route to when matched. */
  model: string;
  /** Provider to route to when matched. */
  provider: string;
};

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
  /** File-based routing rules. Evaluated in order; first match wins. */
  fileRouting?: {
    enabled?: boolean;
    rules?: FileRoutingRule[];
  };
  logging?: boolean;
};

export const DEFAULT_FILE_ROUTING_RULES: FileRoutingRule[] = [
  {
    label: "image",
    mimePatterns: ["image/*"],
    model: "gemini-2.5-flash",
    provider: "google",
  },
  {
    label: "video",
    mimePatterns: ["video/*"],
    model: "gemini-2.5-flash",
    provider: "google",
  },
  {
    label: "audio",
    mimePatterns: ["audio/*"],
    model: "gemini-2.5-flash",
    provider: "google",
  },
  {
    label: "document",
    mimePatterns: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.*",
      "application/vnd.ms-*",
      "text/*",
    ],
    model: "gemini-2.5-flash",
    provider: "google",
  },
  {
    label: "binary",
    mimePatterns: ["application/octet-stream", "application/zip", "application/gzip"],
    model: "gemini-2.5-flash",
    provider: "google",
  },
];

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
      // 英語
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
  fileRouting: {
    enabled: true,
    rules: DEFAULT_FILE_ROUTING_RULES,
  },
  logging: true,
};
