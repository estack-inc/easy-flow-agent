import type { Command } from "commander";
import { formatHuman, formatJson } from "../../inspect/formatter.js";
import { inspectImage } from "../../inspect/inspector.js";
import { handleError } from "../../utils/errors.js";

interface InspectCliOptions {
  json: boolean;
}

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect")
    .description("ローカルイメージのメタデータ・レイヤー情報を表示")
    .argument("<ref>", "イメージの ref（例: org/name:1.0）")
    .option("--json", "JSON 形式で出力", false)
    .action(async (ref: string, options: InspectCliOptions) => {
      try {
        const report = await inspectImage(ref);
        if (options.json) {
          console.log(formatJson(report));
        } else {
          console.log(formatHuman(report));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
