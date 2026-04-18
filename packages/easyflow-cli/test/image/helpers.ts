import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";

/**
 * tar.gz Buffer を一時ディレクトリに展開し、ファイルマップ（相対パス → 内容）を返す。
 */
export async function extractTarGz(content: Buffer): Promise<Map<string, Buffer>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-test-extract-"));
  try {
    const extract = tar.x({ cwd: tmpDir });
    await new Promise<void>((resolve, reject) => {
      extract.on("error", reject);
      extract.on("end", resolve);
      extract.on("finish", resolve);
      extract.on("close", resolve);
      Readable.from([content]).pipe(extract);
    });
    return await collectFiles(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function collectFiles(dir: string, prefix = ""): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      result.set(relPath, await fs.readFile(fullPath));
    } else if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, relPath);
      for (const [k, v] of sub) result.set(k, v);
    }
  }
  return result;
}

export function readText(map: Map<string, Buffer>, name: string): string {
  const buf = map.get(name);
  if (!buf) throw new Error(`Layer entry not found: ${name}`);
  return buf.toString("utf-8");
}
