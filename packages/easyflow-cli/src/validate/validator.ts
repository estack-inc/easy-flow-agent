import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentfileParseError, parseAgentfile } from "../agentfile/parser.js";
import type { ValidationIssue, ValidationReport } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 組み込みテンプレートディレクトリ */
const BUILTIN_TEMPLATES_DIR = path.join(__dirname, "../../templates");

/**
 * AgentfileParseError のキーワードとパスからカテゴリを推定する。
 */
function classifyIssue(keyword: string, issuePath?: string): ValidationIssue["category"] {
  if (keyword === "fileExists") {
    return "file-missing";
  }
  if (
    keyword === "baseTemplateNotFound" ||
    keyword === "baseTemplateParse" ||
    keyword === "baseTemplateType"
  ) {
    return "base-resolution";
  }
  if (keyword === "builtinToolName") {
    return "tool-unknown";
  }
  // JSON Schema の enum エラーで tools/builtin パスの場合は tool-unknown
  if (keyword === "enum" && issuePath?.includes("/tools/builtin")) {
    return "tool-unknown";
  }
  if (
    keyword === "yamlParse" ||
    keyword === "type" ||
    keyword === "required" ||
    keyword === "minLength" ||
    keyword === "maxLength" ||
    keyword === "format" ||
    keyword === "enum" ||
    keyword === "pattern" ||
    keyword === "additionalProperties"
  ) {
    return "schema";
  }
  return "other";
}

/**
 * Agentfile をパースしてバリデーション結果を返す。
 * @param filePath Agentfile のパス（絶対または相対パス）
 * @param templatePaths ベーステンプレートの検索パス
 */
export async function validateAgentfile(
  filePath: string,
  templatePaths?: string[],
): Promise<ValidationReport> {
  const absPath = path.resolve(filePath);
  const basedir = path.dirname(absPath);
  const resolvedTemplatePaths = templatePaths ?? [BUILTIN_TEMPLATES_DIR];

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ファイル読み込み
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (e) {
    errors.push({
      category: "file-missing",
      message: `Agentfile not found: ${filePath}`,
      path: filePath,
    });
    return {
      ok: false,
      file: filePath,
      errors,
      warnings,
    };
  }

  // パース・バリデーション
  try {
    await parseAgentfile(content, {
      basedir,
      templatePaths: resolvedTemplatePaths,
    });
  } catch (e) {
    if (e instanceof AgentfileParseError) {
      for (const issue of e.errors) {
        const category = classifyIssue(issue.keyword, issue.path);
        errors.push({
          category,
          message: issue.message,
          ...(issue.path ? { path: issue.path } : {}),
        });
      }
    } else {
      errors.push({
        category: "other",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: errors.length === 0,
    file: filePath,
    errors,
    warnings,
  };
}
