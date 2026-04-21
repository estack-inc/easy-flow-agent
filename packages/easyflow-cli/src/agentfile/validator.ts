import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Ajv as AjvType, ErrorObject } from "ajv";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { agentfileSchema } from "./schema.js";
import type { Agentfile } from "./types.js";

export interface AgentfileValidationError {
  path: string;
  message: string;
  keyword: string;
}

const KNOWN_BUILTIN_TOOLS = ["workflow-controller", "file-serve", "model-router"];
const AjvCtor =
  (
    AjvModule as unknown as {
      default?: new (options: { allErrors: boolean }) => AjvType;
    }
  ).default ?? (AjvModule as unknown as new (options: { allErrors: boolean }) => AjvType);
const addFormats =
  (
    addFormatsModule as unknown as {
      default?: (ajv: AjvType) => void;
    }
  ).default ?? (addFormatsModule as unknown as (ajv: AjvType) => void);

function createAjv(): AjvType {
  const ajv = new AjvCtor({ allErrors: true });
  addFormats(ajv);

  // SemVer 2.0.0 準拠: 数値識別子の先頭ゼロを禁止
  const NUMERIC = "0|[1-9]\\d*";
  const PRE_RELEASE_ID = `(?:${NUMERIC}|[0-9a-zA-Z-]*[a-zA-Z-][0-9a-zA-Z-]*)`;
  const BUILD_ID = "[0-9a-zA-Z-]+";
  const SEMVER_RE = new RegExp(
    `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
      `(?:-(${PRE_RELEASE_ID}(?:\\.${PRE_RELEASE_ID})*))?` +
      `(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`,
  );

  ajv.addFormat("semver", {
    type: "string",
    validate: (value: string) => SEMVER_RE.test(value),
  });

  return ajv;
}

/**
 * JSON Schema によるバリデーション。
 * @returns バリデーションエラーの配列（空なら成功）
 */
export function validateSchema(data: unknown): AgentfileValidationError[] {
  const ajv = createAjv();
  const validate = ajv.compile(agentfileSchema);

  if (validate(data)) {
    return [];
  }

  return (validate.errors ?? []).map((err: ErrorObject) => ({
    path: err.instancePath || "/",
    message: err.message ?? "Unknown validation error",
    keyword: err.keyword,
  }));
}

export interface SemanticValidationOptions {
  basedir: string;
  /** ファイル存在チェックをスキップ（deploy 時など、レイヤーに焼き込み済みの場合） */
  skipFileExistenceCheck?: boolean;
}

/**
 * JSON Schema 以外のセマンティックバリデーション。
 * parseAgentfile 内で JSON Schema バリデーション後に呼ばれる。
 */
export function validateSemantic(
  agentfile: Agentfile,
  options: SemanticValidationOptions,
): AgentfileValidationError[] {
  const errors: AgentfileValidationError[] = [];

  // agents_core 排他チェック
  if (agentfile.agents_core?.file && agentfile.agents_core?.inline) {
    errors.push({
      path: "/agents_core",
      message: "file and inline are mutually exclusive",
      keyword: "agentsCoreExclusive",
    });
  }

  // チャネル有効確認
  if (agentfile.channels) {
    const hasEnabled = Object.values(agentfile.channels).some((ch) => ch?.enabled);
    if (!hasEnabled) {
      errors.push({
        path: "/channels",
        message: "At least one channel must be enabled",
        keyword: "channelEnabled",
      });
    }
  } else {
    errors.push({
      path: "/channels",
      message: "At least one channel must be enabled",
      keyword: "channelEnabled",
    });
  }

  // ツール名有効性
  if (agentfile.tools?.builtin) {
    for (const tool of agentfile.tools.builtin) {
      if (!KNOWN_BUILTIN_TOOLS.includes(tool)) {
        errors.push({
          path: "/tools/builtin",
          message: `Unknown builtin tool: ${tool}`,
          keyword: "builtinToolName",
        });
      }
    }
  }

  // ファイルパス存在確認（skipFileExistenceCheck が true なら全スキップ）
  if (!options.skipFileExistenceCheck) {
    // ファイルパス存在確認: knowledge.sources[].path
    if (agentfile.knowledge?.sources) {
      for (let i = 0; i < agentfile.knowledge.sources.length; i++) {
        const source = agentfile.knowledge.sources[i];
        const fullPath = resolve(options.basedir, source.path);
        if (!existsSync(fullPath)) {
          errors.push({
            path: `/knowledge/sources/${i}/path`,
            message: `File not found: ${source.path}`,
            keyword: "fileExists",
          });
        }
      }
    }

    // ファイルパス存在確認: agents_core.file
    if (agentfile.agents_core?.file) {
      const fullPath = resolve(options.basedir, agentfile.agents_core.file);
      if (!existsSync(fullPath)) {
        errors.push({
          path: "/agents_core/file",
          message: `File not found: ${agentfile.agents_core.file}`,
          keyword: "fileExists",
        });
      }
    }

    // ファイルパス存在確認: tools.custom[].path
    if (agentfile.tools?.custom) {
      for (let i = 0; i < agentfile.tools.custom.length; i++) {
        const tool = agentfile.tools.custom[i];
        const fullPath = resolve(options.basedir, tool.path);
        if (!existsSync(fullPath)) {
          errors.push({
            path: `/tools/custom/${i}/path`,
            message: `File not found: ${tool.path}`,
            keyword: "fileExists",
          });
        }
      }
    }
  }

  return errors;
}
