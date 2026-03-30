import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileMeta } from "./meta.js";
import { parseMetaSafe } from "./meta.js";

export const FILE_SERVE_DIR = "/data/file-serve";

export type SaveFileInput = {
  sourceFilePath: string;
  filename: string;
  mimeType: string;
  ttlDays?: number;
  storageDir?: string;
  baseUrl: string;
  /** ソースファイルの許可ディレクトリ。設定時はこのディレクトリ外のファイルを拒否する。 */
  allowedSourceDir?: string;
};

// allowedSourceDir 未設定時にブロックする危険なシステムパス
const BLOCKED_SOURCE_PREFIXES = ["/etc/", "/proc/", "/sys/", "/root/", "/boot/", "/dev/"];

function validateSourceFilePath(filePath: string, allowedSourceDir?: string): void {
  const resolved = path.resolve(filePath);
  if (allowedSourceDir) {
    const normalizedBase = path.resolve(allowedSourceDir);
    const prefix = normalizedBase.endsWith(path.sep) ? normalizedBase : normalizedBase + path.sep;
    if (!resolved.startsWith(prefix) && resolved !== normalizedBase) {
      throw new Error(`ソースファイルが許可ディレクトリ外です: ${resolved}`);
    }
  } else {
    for (const prefix of BLOCKED_SOURCE_PREFIXES) {
      if (resolved.startsWith(prefix)) {
        throw new Error(`許可されていないソースパス: ${resolved}`);
      }
    }
  }
}

export type SaveFileResult = {
  uuid: string;
  servedUrl: string;
};

/** ファイルをボリュームにコピーし、meta.json を生成 */
export async function saveFile(input: SaveFileInput): Promise<SaveFileResult> {
  const {
    sourceFilePath,
    filename,
    mimeType,
    ttlDays = 7,
    storageDir = FILE_SERVE_DIR,
    baseUrl,
    allowedSourceDir,
  } = input;

  validateSourceFilePath(sourceFilePath, allowedSourceDir);

  const uuid = randomUUID();
  const destDir = path.join(storageDir, uuid);

  await fs.promises.mkdir(destDir, { recursive: true });

  try {
    const safeFilename = path.basename(filename);
    const destFilePath = path.join(destDir, safeFilename);
    await fs.promises.copyFile(sourceFilePath, destFilePath);

    const stat = await fs.promises.stat(destFilePath);

    const meta: FileMeta = {
      filename: safeFilename,
      mimeType,
      createdAt: new Date().toISOString(),
      ttlDays,
      sizeBytes: stat.size,
    };

    await fs.promises.writeFile(
      path.join(destDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );

    const servedUrl = `${baseUrl}/files/${uuid}/${encodeURIComponent(safeFilename)}`;
    return { uuid, servedUrl };
  } catch (err) {
    // コピーや meta.json 書き込みが失敗した場合、作成したディレクトリを削除してロールバック
    await fs.promises.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** meta.json を読み込む（存在しない場合・検証失敗の場合は null） */
export async function readMeta(
  uuid: string,
  storageDir: string = FILE_SERVE_DIR,
): Promise<FileMeta | null> {
  const metaPath = path.join(storageDir, uuid, "meta.json");
  try {
    const raw = await fs.promises.readFile(metaPath, "utf-8");
    return parseMetaSafe(raw);
  } catch {
    return null;
  }
}
