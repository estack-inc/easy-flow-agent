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
    if (!sourceFilePath) return undefined;

    // LINE チャネルのみ処理
    if (!ctx.sessionKey?.startsWith("line:")) {
      logger.debug?.(`LINE 以外のチャネルはスキップ: ${ctx.sessionKey}`);
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
