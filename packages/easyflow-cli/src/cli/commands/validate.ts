import type { Command } from "commander";
import { formatHuman, formatJson } from "../../validate/formatter.js";
import { validateAgentfile } from "../../validate/validator.js";

interface ValidateCliOptions {
  file: string;
  json: boolean;
}

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Agentfile のスキーマ・ファイル存在・base 解決を検証")
    .requiredOption("-f, --file <path>", "Agentfile のパス")
    .option("--json", "JSON 形式で出力", false)
    .action(async (options: ValidateCliOptions) => {
      const report = await validateAgentfile(options.file);
      if (options.json) {
        console.log(formatJson(report));
      } else {
        console.log(formatHuman(report));
      }
      if (!report.ok) {
        process.exit(1);
      }
    });
}
