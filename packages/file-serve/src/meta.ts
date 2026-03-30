export type FileMeta = {
  filename: string;
  mimeType: string;
  createdAt: string; // ISO 8601
  ttlDays: number;
  sizeBytes: number;
};

/** TTL 有効期限内かどうかを判定 */
export function isWithinTtl(meta: FileMeta): boolean {
  const createdAtMs = new Date(meta.createdAt).getTime();
  if (Number.isNaN(createdAtMs)) return false;
  const expiresAt = createdAtMs + meta.ttlDays * 86400000;
  return Date.now() < expiresAt;
}

// MIME タイプのフォーマット検証（ヘッダーインジェクション防止。ホワイトリストは http-handler で管理）
const VALID_MIME_REGEX = /^[\w.+-]+\/[\w.+-]+$/;
// ファイル名検証（パス区切り文字を含まないこと）
const VALID_FILENAME_REGEX = /^[^/\\]+$/;

/**
 * meta.json の文字列を安全にパース・検証する。
 * 不正なフィールドが含まれる場合は null を返す。
 */
export function parseMetaSafe(raw: string): FileMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.filename !== "string" || !VALID_FILENAME_REGEX.test(m.filename)) return null;
  if (typeof m.mimeType !== "string" || !VALID_MIME_REGEX.test(m.mimeType)) return null;
  if (typeof m.createdAt !== "string" || Number.isNaN(new Date(m.createdAt).getTime())) return null;
  if (typeof m.ttlDays !== "number" || m.ttlDays <= 0 || m.ttlDays > 3650) return null;
  if (typeof m.sizeBytes !== "number" || m.sizeBytes < 0 || !Number.isFinite(m.sizeBytes))
    return null;
  return m as unknown as FileMeta;
}
