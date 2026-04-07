/**
 * model-router パッケージのドメイン型定義。
 * classifier.ts と session-store.ts の循環依存を避けるため、
 * 共通型はこのファイルに集約する。
 */

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

export type TurnRecord = {
  reason: ClassificationReason;
  timestamp: number;
};

export type SessionContext = {
  recentTurns: TurnRecord[];
};
