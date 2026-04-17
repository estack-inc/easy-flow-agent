import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Agentfile } from "../../agentfile/types.js";
import { packLayer, type PackEntry } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * identity レイヤー（IDENTITY.md / SOUL.md / POLICY.md / AGENTS-CORE.md）を生成する。
 *
 * - `identity.policy` は Markdown 箇条書きに変換。未指定時は空リストで POLICY.md を生成。
 * - `agents_core` 未指定時は AGENTS-CORE.md を含めない。
 * - `agents_core.file` は `basedir` 基準でパス解決し、ファイル内容を AGENTS-CORE.md として格納。
 */
export async function buildIdentityLayer(
  agentfile: Agentfile,
  basedir: string,
): Promise<LayerData> {
  const { identity, agents_core } = agentfile;

  const entries: PackEntry[] = [
    { kind: "file", name: "IDENTITY.md", content: renderIdentity(agentfile) },
    { kind: "file", name: "SOUL.md", content: renderSoul(identity.soul) },
    { kind: "file", name: "POLICY.md", content: renderPolicy(identity.policy) },
  ];

  if (agents_core) {
    const coreBody = await resolveAgentsCore(agents_core, basedir);
    entries.push({ kind: "file", name: "AGENTS-CORE.md", content: coreBody });
  }

  return packLayer(entries);
}

function renderIdentity(agentfile: Agentfile): string {
  const { identity, metadata } = agentfile;
  const lines = [
    `# ${identity.name}`,
    "",
    `- name: ${metadata.name}`,
    `- version: ${metadata.version}`,
    `- description: ${metadata.description}`,
    `- author: ${metadata.author}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

function renderSoul(soul: string): string {
  const body = soul.endsWith("\n") ? soul : `${soul}\n`;
  return `# Soul\n\n${body}`;
}

function renderPolicy(policy: readonly string[] | undefined): string {
  const items = policy ?? [];
  const listing = items.length === 0 ? "" : `${items.map((p) => `- ${p}`).join("\n")}\n`;
  return `# Policy\n\n${listing}`;
}

async function resolveAgentsCore(
  agentsCore: NonNullable<Agentfile["agents_core"]>,
  basedir: string,
): Promise<string> {
  if (agentsCore.inline !== undefined) {
    return agentsCore.inline.endsWith("\n") ? agentsCore.inline : `${agentsCore.inline}\n`;
  }
  if (agentsCore.file !== undefined) {
    const filePath = path.resolve(basedir, agentsCore.file);
    const raw = await fs.readFile(filePath, "utf-8");
    return raw.endsWith("\n") ? raw : `${raw}\n`;
  }
  return "";
}
