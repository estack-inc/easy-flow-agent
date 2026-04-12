import path from "node:path";
import mime from "mime-types";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import { saveFile } from "./storage.js";

/** LINE が画像メッセージ（media）として送信可能な MIME タイプ（JPEG/PNG のみ公式サポート） */
const LINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

/** media 送信時のプレビュー画像サイズ上限（LINE 仕様: 1 MB） */
const LINE_PREVIEW_IMAGE_MAX_BYTES = 1 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildDownloadText(
  filename: string,
  sizeBytes: number,
  downloadUrl: string,
  ttlDays: number,
): string {
  return `📄 ${filename}（${formatFileSize(sizeBytes)}）\n${downloadUrl}\n有効期限: ${ttlDays}日間`;
}

/** JSON 文字列の終端位置を返す。文字列値・エスケープを考慮し } の誤検出を防ぐ。 */
function findJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return 0;
}

/**
 * AI が Flex Message JSON を message パラメータに直接埋め込んだ場合に検出し、
 * file-serve ダウンロード URL を含む plain text に変換する。
 * Flex JSON でない場合や file-serve URL が含まれない場合は null を返す。
 */
function sanitizeFlexJson(message: string, logger: PluginLogger): string | null {
  if (!message.startsWith('{"type":"flex"')) return null;

  const urlMatch = message.match(/https?:\/\/[^"\s]+\/files\/[a-f0-9-]+\/[^"\s]+/);
  if (!urlMatch) return null;

  const downloadUrl = urlMatch[0];
  const filename = decodeURIComponent(downloadUrl.split("/").pop() || "file");

  // Flex JSON の終端を検出し、後続テキストを保持
  // JSON 文字列値内の } で誤動作しないよう、文字列・エスケープを考慮
  const jsonEnd = findJsonEnd(message);
  const trailingText = jsonEnd > 0 ? message.slice(jsonEnd).trim() : "";

  logger.info(`Flex JSON を検出、plain text に変換: ${downloadUrl}`);
  return `📄 ${filename}\n${downloadUrl}${trailingText ? "\n" + trailingText : ""}`;
}

export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
};

export function createBeforeToolCallHook(config: FileServeConfig, logger: PluginLogger) {
  return async (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | undefined> => {
    // message ツール以外はスキップ
    if (event.toolName !== "message") return undefined;

    // filePath または media が存在するかチェック
    const sourceFilePath =
      (event.params.filePath as string | undefined) || (event.params.media as string | undefined);

    // LINE チャネルのみ処理
    if (!ctx.sessionKey?.startsWith("line:")) {
      logger.debug?.(`LINE 以外のチャネルはスキップ: ${ctx.sessionKey}`);
      return undefined;
    }

    // Flex JSON がメッセージに直接含まれている場合の検出・変換
    // AI がセッションコンテキストから旧ワークアラウンドを使用するケースに対応
    if (!sourceFilePath) {
      const message = event.params.message as string | undefined;
      if (message) {
        const sanitized = sanitizeFlexJson(message, logger);
        if (sanitized) return { params: { ...event.params, message: sanitized } };
      }
      return undefined;
    }

    const filename = path.basename(sourceFilePath);
    const detectedMime = (mime.lookup(filename) as string | false) || "application/octet-stream";

    let saveResult: Awaited<ReturnType<typeof saveFile>>;
    try {
      saveResult = await saveFile({
        sourceFilePath,
        filename,
        mimeType: detectedMime,
        ttlDays: config.ttlDays,
        storageDir: config.storageDir,
        baseUrl: config.baseUrl,
        allowedSourceDir: config.allowedSourceDir,
      });
    } catch (err) {
      logger.error(`ファイル保存失敗: ${err instanceof Error ? err.message : String(err)}`);
      // ローカルパスが LINE 等の外部サービスに漏洩しないようツール呼び出しをブロック
      return { block: true };
    }

    logger.info(`ファイル保存完了: uuid=${saveResult.uuid} url=${saveResult.servedUrl}`);

    const updatedParams = { ...event.params };

    const isLineImage =
      LINE_IMAGE_MIME_TYPES.has(detectedMime) &&
      saveResult.sizeBytes <= LINE_PREVIEW_IMAGE_MAX_BYTES;

    if (isLineImage) {
      // JPEG/PNG かつ 1 MB 以下: LINE 画像メッセージとして送信
      updatedParams.media = saveResult.servedUrl;
      delete updatedParams.filePath;
    } else {
      // それ以外（PDF/Excel/大きい画像/GIF/WebP 等）: テキスト URL で案内
      updatedParams.message = buildDownloadText(
        filename,
        saveResult.sizeBytes,
        saveResult.servedUrl,
        config.ttlDays,
      );
      delete updatedParams.filePath;
      delete updatedParams.media;
    }

    return { params: updatedParams };
  };
}
