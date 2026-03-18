// packages/workflow-controller/src/validators/types.ts

/**
 * バリデーションサブエージェントの共通インターフェース
 */
export type ValidationRating = "PASS" | "NEEDS_IMPROVEMENT" | "MAJOR_ISSUES";

export type ChecklistItem = {
  item: string;
  result: "\u2705" | "\u274C";
  comment: string;
};

export type ValidationIssue = {
  severity: "high" | "medium" | "low";
  description: string;
  suggestion: string;
};

export type ValidationResult = {
  rating: ValidationRating;
  checklist: ChecklistItem[];
  issues: ValidationIssue[];
  summary: string;
};
