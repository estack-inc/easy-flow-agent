import fs from "node:fs";
import path from "node:path";
import type { FileServeConfig } from "./config.js";
import type { PluginLogger } from "./index.js";
import { parseMetaSafe } from "./meta.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 時間
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      // UUID v4 形式でないエントリ（.DS_Store 等）はスキップして誤削除を防ぐ
      if (!UUID_V4_REGEX.test(entry)) {
        logger.warn(`非 UUID エントリをスキップ: ${entry}`);
        continue;
      }

      const entryDir = path.join(storageDir, entry);
      const metaPath = path.join(entryDir, "meta.json");

      try {
        const raw = await fs.promises.readFile(metaPath, "utf-8");
        const meta = parseMetaSafe(raw);
        if (!meta) {
          logger.warn(`meta.json の検証失敗、スキップ: ${entry}`);
          continue;
        }
        const expiresAt = new Date(meta.createdAt).getTime() + meta.ttlDays * 86400000;

        if (Date.now() > expiresAt) {
          await fs.promises.rm(entryDir, { recursive: true, force: true });
          deletedCount++;
          logger.info(`削除完了: ${entry}`);
        }
      } catch {
        // meta.json が読み込めないディレクトリはスキップ
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
      }, CLEANUP_INTERVAL_MS).unref();
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
