import type { Command } from "commander";
import { ImageStore } from "../../store/image-store.js";
import { handleError } from "../../utils/errors.js";

export function registerImagesCommand(program: Command): void {
  const images = program
    .command("images")
    .description("ローカルイメージの管理")
    .action(async () => {
      try {
        const store = new ImageStore();
        const list = await store.list();

        if (list.length === 0) {
          console.log("ローカルイメージはありません。");
          return;
        }

        // Table format
        console.log(`${"REF".padEnd(40)} ${"DIGEST".padEnd(20)} ${"SIZE".padEnd(10)} CREATED`);
        for (const img of list) {
          const shortDigest = img.digest.slice(0, 19);
          const sizeStr = formatBytes(img.size);
          const created = img.createdAt.slice(0, 10);
          console.log(
            `${img.ref.padEnd(40)} ${shortDigest.padEnd(20)} ${sizeStr.padEnd(10)} ${created}`,
          );
        }
      } catch (error) {
        handleError(error);
      }
    });

  images
    .command("rm <ref>")
    .description("イメージを削除")
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      try {
        const dryRun = cmd.optsWithGlobals().dryRun === true;
        if (dryRun) {
          console.log(`[dry-run] 削除対象: ${ref}`);
          return;
        }
        const store = new ImageStore();
        const removed = await store.remove(ref);
        if (removed) {
          console.log(`削除しました: ${ref}`);
        } else {
          console.error(`イメージが見つかりません: ${ref}`);
          process.exit(1);
        }
      } catch (error) {
        handleError(error);
      }
    });

  images
    .command("prune")
    .description("未使用イメージを削除")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const dryRun = cmd.optsWithGlobals().dryRun === true;
        if (dryRun) {
          console.log("[dry-run] prune をスキップしました");
          return;
        }
        const store = new ImageStore();
        const result = await store.prune();
        console.log(`${result.removed} 件削除しました (${formatBytes(result.freedBytes)} 解放)`);
      } catch (error) {
        handleError(error);
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
