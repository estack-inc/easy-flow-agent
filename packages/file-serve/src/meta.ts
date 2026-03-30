export type FileMeta = {
  filename: string;
  mimeType: string;
  createdAt: string; // ISO 8601
  ttlDays: number;
  sizeBytes: number;
};

/** TTL 有効期限内かどうかを判定 */
export function isWithinTtl(meta: FileMeta): boolean {
  const expiresAt = new Date(meta.createdAt).getTime() + meta.ttlDays * 86400000;
  return Date.now() < expiresAt;
}
