import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TemplateMeta, TemplateSnapshot } from "./types.js";

interface TextFileEntry {
  key: Exclude<keyof TemplateSnapshot, "rootDir" | "hasWorkspaceDir" | "metaJson">;
  filename: string;
}

const TEXT_FILES: TextFileEntry[] = [
  { key: "identityMd", filename: "IDENTITY.md" },
  { key: "soulMd", filename: "SOUL.md" },
  { key: "policyMd", filename: "POLICY.md" },
  { key: "agentsMd", filename: "AGENTS.md" },
  { key: "agentsCoreMd", filename: "AGENTS-CORE.md" },
  { key: "toolsMd", filename: "TOOLS.md" },
  { key: "readmeMd", filename: "README.md" },
  { key: "entrypointSh", filename: "entrypoint.sh" },
];

async function readIfExists(path: string): Promise<string | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  return readFile(path, "utf-8");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * テンプレートディレクトリから既知のファイル群を読み込み、TemplateSnapshot を返す。
 * 見つからないファイルは undefined として扱う（エラーにしない）。
 * meta.json のパース失敗時のみ例外を投げる。
 */
export async function loadTemplateSnapshot(rootDir: string): Promise<TemplateSnapshot> {
  const snapshot: TemplateSnapshot = {
    rootDir,
    hasWorkspaceDir: isDirectory(join(rootDir, "workspace")),
  };

  for (const entry of TEXT_FILES) {
    const content = await readIfExists(join(rootDir, entry.filename));
    if (content !== undefined) {
      snapshot[entry.key] = content;
    }
  }

  const metaPath = join(rootDir, "meta.json");
  const metaRaw = await readIfExists(metaPath);
  if (metaRaw !== undefined) {
    try {
      snapshot.metaJson = JSON.parse(metaRaw) as TemplateMeta;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`meta.json のパースに失敗しました (${metaPath}): ${reason}`);
    }
  }

  return snapshot;
}
