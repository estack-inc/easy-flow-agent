import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Agentfile, CustomTool } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

interface ToolsManifest {
  builtin: string[];
  custom: Array<{ name: string; source: string }>;
}

/**
 * tools レイヤー（tools.json + custom/ ディレクトリ）を生成する。
 *
 * - `tools.builtin` と `tools.custom[].name` を tools.json に記録。
 * - `tools.custom[].path` が指すディレクトリ/ファイルを `custom/<name>/` に格納。
 */
export async function buildToolsLayer(agentfile: Agentfile, basedir: string): Promise<LayerData> {
  const builtin = agentfile.tools?.builtin ?? [];
  const customTools = agentfile.tools?.custom ?? [];

  const manifest: ToolsManifest = {
    builtin: [...builtin],
    custom: customTools.map((t) => ({ name: t.name, source: `custom/${t.name}` })),
  };

  const entries: PackEntry[] = [
    {
      kind: "file",
      name: "tools.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];

  for (const tool of customTools) {
    entries.push(...(await buildCustomEntries(tool, basedir)));
  }

  return packLayer(entries);
}

async function buildCustomEntries(tool: CustomTool, basedir: string): Promise<PackEntry[]> {
  const absSource = path.resolve(basedir, tool.path);
  const stat = await fs.stat(absSource);
  const destDirName = `custom/${tool.name}`;

  if (stat.isDirectory()) {
    return [{ kind: "dir", name: destDirName, sourceDir: absSource }];
  }
  // 単一ファイルは custom/<name>/<basename> として格納
  const content = await fs.readFile(absSource);
  const fileName = path.basename(absSource);
  return [{ kind: "file", name: `${destDirName}/${fileName}`, content }];
}
