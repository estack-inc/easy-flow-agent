export interface ValidationReport {
  ok: boolean;
  file: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidationIssue {
  category: "schema" | "file-missing" | "base-resolution" | "tool-unknown" | "reference" | "other";
  message: string;
  path?: string;
}
