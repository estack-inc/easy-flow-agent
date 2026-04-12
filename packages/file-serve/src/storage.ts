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
// NOTE: ブロックリスト方式は最低限の防御。allowedSourceDir を明示設定することを強く推奨する。
const BLOCKED_SOURCE_PREFIXES = [
  "/etc/",
  "/proc/",
  "/sys/",
  "/root/",
  "/home/",
  "/boot/",
  "/dev/",
  "/app/", // アプリソースコード・.env 等の漏洩防止
  "/data/openclaw.json", // OpenClaw 設定ファイル
  "/data/lcm.db", // LCM データベース
  "/data/file-serve/", // file-serve ストレージ自体の再配信防止
  "/data/extensions/", // プラグインソースコード
  "/data/easy-flow-agent/", // エージェントソースコード
  "/var/", // ログ・データベース等
  "/opt/", // オプションパッケージ
  "/usr/", // システムユーティリティ
];

async function validateSourceFilePath(filePath: string, allowedSourceDir?: string): Promise<void> {
  // realpath でシンボリックリンクを解決してから検証する。
  // path.resolve() はパス文字列を正規化するだけでリンクを辿らないため、
  // /tmp/uploads/leak.pdf → /etc/passwd のようなシンボリックリンク経由の検証バイパスを防ぐ。
  // ENOENT 以外（EPERM 等）を含む全エラーを伝播させ、フォールバックしない。
  // フォールバックすると EPERM 等でシンボリックリンク解決がバイパスされるリスクがある。
  const resolved = await fs.promises.realpath(filePath);
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
  sizeBytes: number;
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

  await validateSourceFilePath(sourceFilePath, allowedSourceDir);

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
    return { uuid, servedUrl, sizeBytes: stat.size };
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
