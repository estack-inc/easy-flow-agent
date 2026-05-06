import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { Agentfile } from "./types.js";
import type { AgentfileValidationError } from "./validator.js";
import { validateSchema, validateSemantic } from "./validator.js";

export type { AgentfileValidationError };

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 組み込みテンプレートディレクトリ */
const BUILTIN_TEMPLATES_DIR = join(__dirname, "../../templates");

/** base 短縮名の一覧 */
const SHORT_BASE_NAMES = ["monitor"];

export interface ParseOptions {
  /** Agentfile のディレクトリ（相対パス解決用） */
  basedir: string;
  /** ベーステンプレートの検索パス（デフォルト: 組み込みテンプレート） */
  templatePaths?: string[];
  /** ファイル存在チェックをスキップ（deploy 時など、レイヤーに焼き込み済みの場合） */
  skipFileExistenceCheck?: boolean;
}

export interface ParseResult {
  /** パース・マージ済みの Agentfile */
  agentfile: Agentfile;
  /** 使用したベーステンプレート（なければ undefined） */
  resolvedBase?: string;
}

export class AgentfileParseError extends Error {
  constructor(
    message: string,
    public readonly errors: AgentfileValidationError[],
  ) {
    super(message);
    this.name = "AgentfileParseError";
  }
}

/**
 * base フィールドからテンプレート名を抽出する。
 * - 短縮名: "monitor" → "monitor"
 * - フルパス: "estack-inc/monitor:latest" → "monitor"
 */
function extractTemplateName(base: string): string {
  if (SHORT_BASE_NAMES.includes(base)) {
    return base;
  }
  // <org>/<name>:<tag> 形式 → name 部分を抽出
  const match = base.match(/^[a-z0-9-]+\/([a-z0-9-]+):[a-z0-9._-]+$/);
  if (match) {
    return match[1];
  }
  return base;
}

/**
 * テンプレートファイルを検索パスから解決する。
 */
function resolveTemplate(templateName: string, templatePaths: string[]): string | undefined {
  for (const dir of templatePaths) {
    const filePath = join(dir, `${templateName}.yaml`);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return undefined;
}

/**
 * 値のディープマージ（config 用）。
 * child の値が parent を部分的に上書きする。
 */
function deepMerge(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...parent };
  for (const key of Object.keys(child)) {
    const parentVal = parent[key];
    const childVal = child[key];
    if (
      parentVal &&
      childVal &&
      typeof parentVal === "object" &&
      typeof childVal === "object" &&
      !Array.isArray(parentVal) &&
      !Array.isArray(childVal)
    ) {
      result[key] = deepMerge(
        parentVal as Record<string, unknown>,
        childVal as Record<string, unknown>,
      );
    } else {
      result[key] = childVal;
    }
  }
  return result;
}

/**
 * テンプレート内の相対パスを子 Agentfile の basedir 基準に変換する。
 * テンプレートが別ディレクトリにある場合、相対パスを正しく解決するために必要。
 */
function resolveTemplatePaths(
  parent: Agentfile,
  templateDir: string,
  childBasedir: string,
): Agentfile {
  const resolved = structuredClone(parent);

  const rebase = (p: string): string => {
    const abs = resolve(templateDir, p);
    return relative(childBasedir, abs) || ".";
  };

  if (resolved.knowledge?.sources) {
    for (const source of resolved.knowledge.sources) {
      source.path = rebase(source.path);
    }
  }
  if (resolved.agents_core?.file) {
    resolved.agents_core.file = rebase(resolved.agents_core.file);
  }
  if (resolved.tools?.custom) {
    for (const tool of resolved.tools.custom) {
      tool.path = rebase(tool.path);
    }
  }

  return resolved;
}

/**
 * 継承マージを実行する。
 * 設計書 §2.3 のマージ戦略に準拠。
 */
function mergeAgentfiles(parent: Agentfile, child: Agentfile): Agentfile {
  const merged: Agentfile = { ...child };

  // identity: 上書き（子の定義が親を完全に置換）
  merged.identity = child.identity ?? parent.identity;

  // agents_core: 上書き
  merged.agents_core = child.agents_core ?? parent.agents_core;

  // channels: 上書き
  merged.channels = child.channels ?? parent.channels;

  // knowledge: 追加（親の sources に子の sources を追加）
  if (parent.knowledge || child.knowledge) {
    const parentSources = parent.knowledge?.sources ?? [];
    const childSources = child.knowledge?.sources ?? [];
    const mergedConfig = child.knowledge?.config ?? parent.knowledge?.config;
    merged.knowledge = {
      sources: [...parentSources, ...childSources],
      ...(mergedConfig ? { config: mergedConfig } : {}),
    };
    // sources が空なら knowledge 自体を除外
    if (merged.knowledge.sources.length === 0) {
      merged.knowledge = undefined;
    }
  }

  // tools: マージ（builtin は重複除外）
  if (parent.tools || child.tools) {
    const parentBuiltin = parent.tools?.builtin ?? [];
    const childBuiltin = child.tools?.builtin ?? [];
    const mergedBuiltin = [...new Set([...parentBuiltin, ...childBuiltin])];

    const parentCustom = parent.tools?.custom ?? [];
    const childCustom = child.tools?.custom ?? [];

    merged.tools = {
      ...(mergedBuiltin.length > 0 ? { builtin: mergedBuiltin } : {}),
      ...(parentCustom.length > 0 || childCustom.length > 0
        ? { custom: [...parentCustom, ...childCustom] }
        : {}),
    };
    // tools が空なら除外
    if (!merged.tools.builtin && !merged.tools.custom) {
      merged.tools = undefined;
    }
  }

  // config: ディープマージ
  if (parent.config || child.config) {
    merged.config = deepMerge(
      (parent.config ?? {}) as Record<string, unknown>,
      (child.config ?? {}) as Record<string, unknown>,
    ) as Agentfile["config"];
    // config が空オブジェクトなら除外
    if (Object.keys(merged.config ?? {}).length === 0) {
      merged.config = undefined;
    }
  }

  return merged;
}

/**
 * Agentfile YAML をパースし、バリデーション・継承マージを行う。
 * @throws AgentfileParseError バリデーション失敗時
 */
export async function parseAgentfile(content: string, options: ParseOptions): Promise<ParseResult> {
  // 1. YAML パース
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    throw new AgentfileParseError(
      `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
      [
        {
          path: "/",
          message: `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
          keyword: "yamlParse",
        },
      ],
    );
  }

  if (!raw || typeof raw !== "object") {
    throw new AgentfileParseError("Agentfile must be a YAML object", [
      { path: "/", message: "Agentfile must be a YAML object", keyword: "type" },
    ]);
  }

  // 2. JSON Schema バリデーション
  const schemaErrors = validateSchema(raw);
  if (schemaErrors.length > 0) {
    throw new AgentfileParseError(
      `Agentfile validation failed: ${schemaErrors.map((e) => e.message).join(", ")}`,
      schemaErrors,
    );
  }

  let agentfile = raw as Agentfile;

  // 3. base テンプレート解決・継承マージ
  const templatePaths = options.templatePaths ?? [BUILTIN_TEMPLATES_DIR];

  // base フィールドの解決（省略時はデフォルト "monitor"）
  const baseValue = agentfile.base ?? "monitor";
  const templateName = extractTemplateName(baseValue);
  const templateFile = resolveTemplate(templateName, templatePaths);

  let resolvedBase: string | undefined;

  if (templateFile) {
    let templateRaw: unknown;
    try {
      const templateContent = readFileSync(templateFile, "utf-8");
      templateRaw = yaml.load(templateContent);
    } catch (e) {
      throw new AgentfileParseError(
        `Base template parse error: ${e instanceof Error ? e.message : String(e)}`,
        [
          {
            path: "/base",
            message: `Base template parse error: ${e instanceof Error ? e.message : String(e)}`,
            keyword: "baseTemplateParse",
          },
        ],
      );
    }

    if (!templateRaw || typeof templateRaw !== "object") {
      throw new AgentfileParseError(`Base template must be a YAML object: ${templateFile}`, [
        {
          path: "/base",
          message: "Base template must be a YAML object",
          keyword: "baseTemplateType",
        },
      ]);
    }

    // テンプレート自体のバリデーション
    const templateSchemaErrors = validateSchema(templateRaw);
    if (templateSchemaErrors.length > 0) {
      throw new AgentfileParseError(
        `Base template validation failed: ${templateSchemaErrors.map((e) => e.message).join(", ")}`,
        templateSchemaErrors,
      );
    }

    // テンプレート内の相対パスを子の basedir 基準に変換
    const templateDir = dirname(templateFile);
    const parentAgentfile = resolveTemplatePaths(
      templateRaw as Agentfile,
      templateDir,
      options.basedir,
    );
    agentfile = mergeAgentfiles(parentAgentfile, agentfile);
    resolvedBase = baseValue;
  } else if (agentfile.base) {
    // base が明示指定されているのにテンプレートが見つからない場合はエラー
    throw new AgentfileParseError(
      `Base template not found: ${agentfile.base} (resolved as "${templateName}.yaml")`,
      [
        {
          path: "/base",
          message: `Base template not found: ${agentfile.base}`,
          keyword: "baseTemplateNotFound",
        },
      ],
    );
  }

  // 4. セマンティックバリデーション
  const semanticErrors = validateSemantic(agentfile, options);
  if (semanticErrors.length > 0) {
    throw new AgentfileParseError(
      `Agentfile semantic validation failed: ${semanticErrors.map((e) => e.message).join(", ")}`,
      semanticErrors,
    );
  }

  return {
    agentfile,
    resolvedBase,
  };
}
