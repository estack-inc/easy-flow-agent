import yaml from "js-yaml";
import { parseAgentfile } from "../agentfile/parser.js";
import type { Agentfile } from "../agentfile/types.js";
import { inferTools } from "./tools-inferrer.js";
import { ConversionError, type ConvertResult, type TemplateSnapshot } from "./types.js";

const DESCRIPTION_MAX_LENGTH = 200;
const DEFAULT_VERSION = "1.0.0";
const DEFAULT_AUTHOR = "estack-inc";

const METADATA_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const METADATA_NAME_MIN_LENGTH = 3;
const METADATA_NAME_MAX_LENGTH = 64;

function toKebabCase(input: string): string {
  const trimmed = input.trim();
  return trimmed
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidMetadataName(name: string): boolean {
  return (
    METADATA_NAME_PATTERN.test(name) &&
    name.length >= METADATA_NAME_MIN_LENGTH &&
    name.length <= METADATA_NAME_MAX_LENGTH
  );
}

function extractH1(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

/** `IDENTITY.md` のような「ファイル名そのもの」を H1 にしているケースを弾く */
function isFilenameLikeHeading(heading: string): boolean {
  return /^[A-Za-z0-9_-]+\.(md|markdown)$/i.test(heading);
}

function extractFirstParagraph(markdown: string): string | undefined {
  const stripped = markdown.replace(/\r\n/g, "\n").trim();
  for (const block of stripped.split(/\n\s*\n/)) {
    const cleaned = block
      .split("\n")
      .filter((line) => !/^#{1,6}\s+/.test(line) && line.trim().length > 0)
      .join(" ")
      .trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return undefined;
}

function normalizeDescription(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= DESCRIPTION_MAX_LENGTH) {
    return compact;
  }
  return compact.slice(0, DESCRIPTION_MAX_LENGTH);
}

function extractPolicyItems(markdown: string): string[] {
  const items: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

function resolveMetadataName(metaName: string | undefined, templateName: string): string {
  const candidates = [metaName, templateName];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = toKebabCase(candidate);
    if (isValidMetadataName(normalized)) {
      return normalized;
    }
  }
  throw new ConversionError(
    `metadata.name を生成できません（template="${templateName}", meta.name="${metaName ?? ""}"）。` +
      "meta.json.name に ASCII 英数字ベースの名前を設定するか、--template に有効な名前を指定してください",
  );
}

function buildMetadata(
  snapshot: TemplateSnapshot,
  templateName: string,
): { name: string; version: string; description: string; author: string } {
  const meta = snapshot.metaJson ?? {};
  const name = resolveMetadataName(meta.name, templateName);
  const version = meta.version && meta.version.length > 0 ? meta.version : DEFAULT_VERSION;

  let description = meta.description;
  if (!description && snapshot.readmeMd) {
    description = extractFirstParagraph(snapshot.readmeMd);
  }
  const normalizedDescription = normalizeDescription(description ?? `${name} template`);

  const author = meta.author && meta.author.length > 0 ? meta.author : DEFAULT_AUTHOR;

  return { name, version, description: normalizedDescription, author };
}

function buildIdentity(snapshot: TemplateSnapshot, fallbackName: string): Agentfile["identity"] {
  if (!snapshot.soulMd) {
    throw new ConversionError(
      "SOUL.md が見つからないため Agentfile を生成できません。identity.soul は必須フィールドです",
    );
  }

  const soul = snapshot.soulMd.trim();
  if (soul.length === 0) {
    throw new ConversionError("SOUL.md の本文が空のため identity.soul を設定できません");
  }

  let name: string | undefined;
  if (snapshot.identityMd) {
    const heading = extractH1(snapshot.identityMd);
    if (heading && !isFilenameLikeHeading(heading)) {
      name = heading;
    }
  }
  if (!name) {
    name = snapshot.metaJson?.name;
  }
  if (!name) {
    name = fallbackName;
  }

  const identity: Agentfile["identity"] = { name, soul };

  if (snapshot.policyMd) {
    const policy = extractPolicyItems(snapshot.policyMd);
    if (policy.length > 0) {
      identity.policy = policy;
    }
  }

  return identity;
}

function collectInputFiles(snapshot: TemplateSnapshot): string[] {
  const files: string[] = [];
  if (snapshot.identityMd) files.push("IDENTITY.md");
  if (snapshot.soulMd) files.push("SOUL.md");
  if (snapshot.policyMd) files.push("POLICY.md");
  if (snapshot.agentsMd) files.push("AGENTS.md");
  if (snapshot.agentsCoreMd) files.push("AGENTS-CORE.md");
  if (snapshot.toolsMd) files.push("TOOLS.md");
  if (snapshot.readmeMd) files.push("README.md");
  if (snapshot.metaJson) files.push("meta.json");
  if (snapshot.entrypointSh) files.push("entrypoint.sh");
  return files;
}

function serializeAgentfile(agentfile: Agentfile): string {
  return yaml.dump(agentfile, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
}

export interface ConvertToAgentfileOptions {
  templateName: string;
  /**
   * true を指定すると `agents_core.file` / `knowledge.sources` を出力から除外する。
   * `packages/easyflow-cli/templates/` 配下にバンドル配置する用途（base 継承で参照され、
   * 子側の basedir に AGENTS.md / AGENTS-CORE.md が存在しないケースがある）で使う。
   */
  omitFileRefs?: boolean;
}

/**
 * TemplateSnapshot を Agentfile に変換する。
 * @throws ConversionError 必須フィールド（identity.soul 相当）が取得できない場合、
 *   または自己バリデーションに失敗した場合
 */
export async function convertTemplateToAgentfile(
  snapshot: TemplateSnapshot,
  options: ConvertToAgentfileOptions,
): Promise<ConvertResult> {
  const metadata = buildMetadata(snapshot, options.templateName);
  const identity = buildIdentity(snapshot, metadata.name);
  const tools = inferTools(snapshot, { templateName: options.templateName });

  const agentfile: Agentfile = {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata,
    identity,
    tools: { builtin: tools.builtin },
    channels: {
      slack: { enabled: true },
      line: { enabled: true },
      webchat: { enabled: true },
    },
  };

  if (snapshot.agentsCoreMd && !options.omitFileRefs) {
    agentfile.agents_core = { file: "./AGENTS-CORE.md" };
  }

  if (snapshot.agentsMd && !options.omitFileRefs) {
    agentfile.knowledge = {
      sources: [
        {
          path: "./AGENTS.md",
          type: "agents_rule",
          description: "詳細業務ルール",
        },
      ],
    };
  }

  if (snapshot.agentsCoreMd) {
    agentfile.config = { rag: { enabled: true } };
  }

  const yamlText = serializeAgentfile(agentfile);

  // 自己バリデーション: 変換結果を parseAgentfile に通す
  // basedir には snapshot.rootDir を渡し、knowledge.sources / agents_core.file の存在チェックを通す
  try {
    await parseAgentfile(yamlText, {
      basedir: snapshot.rootDir,
      templatePaths: [],
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ConversionError(`変換結果が Agentfile スキーマを満たしません: ${reason}`);
  }

  return {
    agentfile,
    yaml: yamlText,
    inputFiles: collectInputFiles(snapshot),
    warnings: tools.warnings,
  };
}
