import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import { isWithinTtl } from "./meta.js";
import { RateLimiter } from "./rate-limiter.js";
import { FILE_SERVE_DIR, readMeta } from "./storage.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 配信時に許可する MIME タイプ。未知の型は application/octet-stream に正規化して XSS を防ぐ
const ALLOWED_SERVE_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "audio/mpeg",
  "video/mp4",
]);

function buildExpiredHtml(ttlDays: number): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>ファイルの有効期限切れ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;">
  <h1>このファイルの有効期限が切れました</h1>
  <p>ファイルの保持期限（${ttlDays}日間）が過ぎたため、ダウンロードできません。</p>
  <p>エージェントに再度ファイル生成を依頼してください。</p>
</body>
</html>`;
}

export function createHttpHandler(config: FileServeConfig, logger: PluginLogger) {
  const rateLimiter = new RateLimiter(config.rateLimit);
  const storageDir = config.storageDir ?? FILE_SERVE_DIR;

  // 期限切れバケットを定期削除してメモリリークを防ぐ
  setInterval(() => rateLimiter.cleanup(), config.rateLimit.windowMs).unref();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // IP 取得: fly-client-ip（Fly.io の信頼できるヘッダ）優先。
    // x-forwarded-for はクライアントが偽装可能なため Rate Limiting には使用しない。
    const ip = (req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || "unknown";

    const rateResult = rateLimiter.check(ip);
    if (!rateResult.allowed) {
      res.writeHead(429, {
        "Content-Type": "text/plain",
        "Retry-After": String(Math.ceil(rateResult.retryAfterMs / 1000)),
      });
      res.end("Too Many Requests");
      return;
    }

    // URL パース: /files/:uuid/:filename（クエリ文字列を除去してからパース）
    const urlPath = (req.url ?? "").split("?")[0];
    const withoutPrefix = urlPath.replace(/^\/files\/?/, "");
    const slashIdx = withoutPrefix.indexOf("/");

    if (slashIdx === -1) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Missing filename");
      return;
    }

    const uuid = withoutPrefix.slice(0, slashIdx);
    let rawFilename: string;
    try {
      rawFilename = decodeURIComponent(withoutPrefix.slice(slashIdx + 1));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid URL encoding");
      return;
    }
    const filename = path.basename(rawFilename);

    // パストラバーサル検出: rawFilename にパス区切り文字や ".." が含まれる場合は 400
    if (!filename || rawFilename !== filename) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid filename");
      return;
    }

    if (!UUID_V4_REGEX.test(uuid)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid UUID");
      return;
    }

    const meta = await readMeta(uuid, storageDir);
    if (!meta) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (meta.filename !== filename) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (!isWithinTtl(meta)) {
      res.writeHead(410, {
        "Content-Type": "text/html; charset=UTF-8",
        "Content-Security-Policy": "default-src 'none'",
      });
      res.end(buildExpiredHtml(meta.ttlDays));
      return;
    }

    const filePath = path.join(storageDir, uuid, filename);

    // Defense in Depth: 構築したパスが storageDir 配下であることを明示的に検証
    const resolvedFilePath = path.resolve(filePath);
    const resolvedStorageDir = path.resolve(storageDir);
    if (!resolvedFilePath.startsWith(resolvedStorageDir + path.sep)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Invalid path");
      return;
    }

    let fileStat: { size: number };
    try {
      fileStat = await fs.promises.stat(filePath);
    } catch {
      logger.warn(`ファイルが見つかりません: ${filePath}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const safeMimeType = ALLOWED_SERVE_MIME_TYPES.has(meta.mimeType)
      ? meta.mimeType
      : "application/octet-stream";
    res.setHeader("Content-Type", safeMimeType);
    // RFC 6266 / RFC 5987 準拠: ASCII フォールバック + UTF-8 エンコード名
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    // 保存時のサイズではなく実際のファイルサイズを使用（ファイル破損時の不一致を防ぐ）
    res.setHeader("Content-Length", String(fileStat.size));
    res.writeHead(200);

    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      logger.error(`ファイル読み込みエラー: ${err.message}`);
      if (!res.destroyed) {
        res.destroy();
      }
    });
    stream.pipe(res);
  };
}
