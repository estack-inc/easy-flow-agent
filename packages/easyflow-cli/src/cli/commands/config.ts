import type { Command } from "commander";
import { ConfigManager } from "../../config/manager.js";
import { handleError } from "../../utils/errors.js";

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("設定の取得・変更");

  config
    .command("get <key>")
    .description("設定値を取得（FQDN はブラケット記法: auth[ghcr.io].token）")
    .action(async (key: string) => {
      try {
        const manager = new ConfigManager();
        const value = await manager.get(key);
        if (value === undefined) {
          console.log(`(未設定)`);
        } else {
          console.log(value);
        }
      } catch (error) {
        handleError(error);
      }
    });

  config
    .command("set <key> <value>")
    .description("設定値を変更（FQDN はブラケット記法: auth[ghcr.io].token）")
    .action(async (key: string, value: string) => {
      try {
        const dryRun = program.opts().dryRun === true;
        if (dryRun) {
          console.log(`[dry-run] ${key} = ${value}`);
          return;
        }
        const manager = new ConfigManager();
        await manager.set(key, value);
        console.log(`${key} = ${value}`);
      } catch (error) {
        handleError(error);
      }
    });
}
