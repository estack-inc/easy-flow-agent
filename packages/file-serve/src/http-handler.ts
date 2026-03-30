import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import { isWithinTtl } from "./meta.js";
import { RateLimiter } from "./rate-limiter.js";
import { FILE_SERVE_DIR, readMeta } from "./storage.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPIRED_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>ファイルの有効期限切れ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;">
  <h1>このファイルの有効期限が切れました</h1>
  <p>ファイルの保持期限（7日間）が過ぎたため、ダウンロードできません。</p>
  <p>エージェントに再度ファイル生成を依頼してください。</p>
</body>
</html>`;

export function createHttpHandler(config: FileServeConfig, logger: PluginLogger) {
  const rateLimiter = new RateLimiter(config.rateLimit);
  const storageDir = config.storageDir ?? FILE_SERVE_DIR;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // IP 取得（Fly.io の Proxy ヘッダ対応）
    const ip =
      (req.headers["fly-client-ip"] as string) ||
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const rateResult = rateLimiter.check(ip);
    if (!rateResult.allowed) {
      res.writeHead(429, {
        "Content-Type": "text/plain",
        "Retry-After": String(Math.ceil(rateResult.retryAfterMs / 1000)),
      });
      res.end("Too Many Requests");
      return;
    }

    // URL パース: /files/:uuid/:filename
    const urlPath = req.url ?? "";
    const withoutPrefix = urlPath.replace(/^\/files\/?/, "");
    const slashIdx = withoutPrefix.indexOf("/");

    if (slashIdx === -1) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Missing filename");
      return;
    }

    const uuid = withoutPrefix.slice(0, slashIdx);
    const rawFilename = decodeURIComponent(withoutPrefix.slice(slashIdx + 1));
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

    if (!isWithinTtl(meta)) {
      res.writeHead(410, {
        "Content-Type": "text/html; charset=UTF-8",
        "Content-Security-Policy": "default-src 'none'",
      });
      res.end(EXPIRED_HTML);
      return;
    }

    const filePath = path.join(storageDir, uuid, filename);

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      logger.warn(`ファイルが見つかりません: ${filePath}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    res.setHeader("Content-Type", meta.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Content-Length", String(meta.sizeBytes));
    res.writeHead(200);

    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      logger.error(`ファイル読み込みエラー: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  };
}
