import { Command } from "commander";
import { registerConfigCommand } from "./commands/config.js";
import { registerImagesCommand } from "./commands/images.js";

const program = new Command();

program
  .name("easyflow")
  .description("AI エージェントのビルド・配布・デプロイ CLI")
  .version("0.1.0");

// グローバルオプション
program
  .option("--verbose", "詳細ログを出力", false)
  .option("--dry-run", "実行せずにプレビュー", false)
  .option("--no-color", "カラー出力を無効化");

// コマンド登録
registerConfigCommand(program);
registerImagesCommand(program);

// 後続タスクで追加するコマンドのスタブ
const stubCommands = [
  "build",
  "deploy",
  "validate",
  "inspect",
  "push",
  "pull",
  "convert",
  "knowledge",
];
for (const name of stubCommands) {
  program
    .command(name)
    .description(`(未実装 — Task 1.3+ で追加)`)
    .action(() => {
      console.error(`easyflow ${name} は現在未実装です。`);
      process.exit(1);
    });
}

program.parse();
