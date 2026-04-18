import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import type { LayerData } from "./types.js";

/** tar ヘッダの mtime を固定してダイジェスト決定論を保証する */
const DETERMINISTIC_MTIME = new Date(0);

/**
 * レイヤーに含めるファイル / ディレクトリの指定。
 */
export type PackEntry =
  | { kind: "file"; name: string; content: Buffer | string }
  | { kind: "dir"; name: string; sourceDir: string };

/**
 * 指定したエントリ群から tar.gz Buffer を生成し、LayerData として返す。
 *
 * - 一時ディレクトリへ materialize → tar.c で gzip 圧縮 → Buffer に集約。
 * - `portable: true` + 固定 mtime により同一入力から同一ダイジェストを生成する。
 * - ファイルカウントは `kind: "file"` の件数 + コピーしたディレクトリ配下の再帰ファイル数。
 */
export async function packLayer(entries: PackEntry[]): Promise<LayerData> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-layer-"));
  try {
    let fileCount = 0;
    const topLevelNames: string[] = [];

    for (const entry of entries) {
      assertSafeName(entry.name);
      topLevelNames.push(entry.name);

      if (entry.kind === "file") {
        const filePath = path.join(tmpDir, entry.name);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, entry.content);
        await fs.utimes(filePath, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
        fileCount += 1;
      } else {
        const destDir = path.join(tmpDir, entry.name);
        await fs.mkdir(destDir, { recursive: true });
        fileCount += await copyDirRecursive(entry.sourceDir, destDir);
      }
    }

    const sortedNames = [...topLevelNames].sort();
    const buffers: Buffer[] = [];
    const tarStream = tar.create(
      {
        gzip: true,
        cwd: tmpDir,
        portable: true,
        mtime: DETERMINISTIC_MTIME,
      },
      sortedNames,
    );
    for await (const chunk of tarStream) {
      buffers.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(buffers);
    const digest = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;

    return {
      content,
      digest,
      size: content.length,
      fileCount,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** エントリ名にパストラバーサルや絶対パスを禁止 */
function assertSafeName(name: string): void {
  if (!name || name.startsWith("/") || name.includes("..") || name.includes("\0")) {
    throw new Error(`Invalid layer entry name: "${name}"`);
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<number> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      count += await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      await fs.utimes(destPath, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
      count += 1;
    }
    // symlink/その他は現段階では無視（Phase 1）
  }
  return count;
}
