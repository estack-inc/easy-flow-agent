import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { agentfileSchema } from "./schema.js";
import type { Agentfile } from "./types.js";

export interface AgentfileValidationError {
  path: string;
  message: string;
  keyword: string;
}

const KNOWN_BUILTIN_TOOLS = ["workflow-controller", "file-serve", "model-router"];

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  ajv.addFormat("semver", {
    type: "string",
    validate: (value: string) =>
      /^\d+\.\d+\.\d+(-[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$/.test(
        value,
      ),
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

  return (validate.errors ?? []).map((err) => ({
    path: err.instancePath || "/",
    message: err.message ?? "Unknown validation error",
    keyword: err.keyword,
  }));
}

/**
 * JSON Schema 以外のセマンティックバリデーション。
 * parseAgentfile 内で JSON Schema バリデーション後に呼ばれる。
 */
export function validateSemantic(
  agentfile: Agentfile,
  options: { basedir: string },
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

  return errors;
}
