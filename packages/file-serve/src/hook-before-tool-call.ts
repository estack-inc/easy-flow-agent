import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import { saveFile } from "./storage.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFlexMessage(filename: string, sizeBytes: number, downloadUrl: string): object {
  return {
    type: "flex",
    altText: `ファイル: ${filename}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📄 ファイル", weight: "bold", size: "sm", color: "#999999" },
          { type: "text", text: filename, weight: "bold", size: "md", wrap: true },
          { type: "text", text: formatFileSize(sizeBytes), size: "sm", color: "#999999" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "ダウンロード", uri: downloadUrl },
            style: "primary",
          },
        ],
      },
    },
  };
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
    if (!ctx.sessionKey?.includes("line:")) {
      logger.debug?.(`LINE 以外のチャネルはスキップ: ${ctx.sessionKey}`);
      return undefined;
    }

    const filename = path.basename(sourceFilePath);
    const detectedMime = (mime.lookup(filename) as string | false) || "application/octet-stream";

    let saveResult: { uuid: string; servedUrl: string };
    try {
      saveResult = await saveFile({
        sourceFilePath,
        filename,
        mimeType: detectedMime,
        ttlDays: config.ttlDays,
        storageDir: config.storageDir,
        baseUrl: config.baseUrl,
      });
    } catch (err) {
      logger.error(`ファイル保存失敗: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    logger.info(`ファイル保存完了: uuid=${saveResult.uuid} url=${saveResult.servedUrl}`);

    const updatedParams = { ...event.params };

    if (IMAGE_MIME_TYPES.has(detectedMime)) {
      // 画像: media を配信 URL に書き換え
      updatedParams.media = saveResult.servedUrl;
      delete updatedParams.filePath;
    } else {
      // PDF/Excel 等: Flex Message に変換
      let sizeBytes = 0;
      try {
        const stat = await fs.promises.stat(sourceFilePath);
        sizeBytes = stat.size;
      } catch {
        sizeBytes = 0;
      }

      updatedParams.message = JSON.stringify(
        buildFlexMessage(filename, sizeBytes, saveResult.servedUrl),
      );
      delete updatedParams.filePath;
      delete updatedParams.media;
    }

    return { params: updatedParams };
  };
}
