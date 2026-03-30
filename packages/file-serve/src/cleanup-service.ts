import fs from "node:fs";
import path from "node:path";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import type { FileMeta } from "./meta.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 時間

export function createCleanupService(fileServeConfig: FileServeConfig, logger: PluginLogger) {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runCleanup(): Promise<void> {
    const storageDir = fileServeConfig.storageDir;
    logger.info("クリーンアップ開始");
    let deletedCount = 0;

    let entries: string[];
    try {
      entries = await fs.promises.readdir(storageDir);
    } catch (err) {
      logger.warn(`ストレージ読み込み失敗: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      const entryDir = path.join(storageDir, entry);
      const metaPath = path.join(entryDir, "meta.json");

      try {
        const raw = await fs.promises.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw) as FileMeta;
        const expiresAt = new Date(meta.createdAt).getTime() + meta.ttlDays * 86400000;

        if (Date.now() > expiresAt) {
          await fs.promises.rm(entryDir, { recursive: true, force: true });
          deletedCount++;
          logger.info(`削除完了: ${entry}`);
        }
      } catch {
        // meta.json が読めないディレクトリはスキップ
        logger.warn(`meta.json 読み込み失敗、スキップ: ${entry}`);
      }
    }

    logger.info(`クリーンアップ完了: ${deletedCount} 件削除`);
  }

  return {
    id: "file-serve-cleanup",
    async start(): Promise<void> {
      await runCleanup(); // 起動時に一度実行
      timer = setInterval(() => {
        runCleanup().catch((err) => {
          logger.error(`クリーンアップエラー: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, CLEANUP_INTERVAL_MS);
      logger.info("クリーンアップサービス起動完了");
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info("クリーンアップサービス停止");
      }
    },
  };
}
