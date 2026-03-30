import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileMeta } from "./meta.js";

export const FILE_SERVE_DIR = "/data/file-serve";

export type SaveFileInput = {
  sourceFilePath: string;
  filename: string;
  mimeType: string;
  ttlDays?: number;
  storageDir?: string;
  baseUrl: string;
};

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
  } = input;

  const uuid = randomUUID();
  const destDir = path.join(storageDir, uuid);

  await fs.promises.mkdir(destDir, { recursive: true });

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
}

/** meta.json を読み込む（存在しない場合は null） */
export async function readMeta(
  uuid: string,
  storageDir: string = FILE_SERVE_DIR,
): Promise<FileMeta | null> {
  const metaPath = path.join(storageDir, uuid, "meta.json");
  try {
    const raw = await fs.promises.readFile(metaPath, "utf-8");
    return JSON.parse(raw) as FileMeta;
  } catch {
    return null;
  }
}
