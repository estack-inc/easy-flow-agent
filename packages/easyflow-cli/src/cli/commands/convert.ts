import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { convertTemplateToAgentfile } from "../../convert/converter.js";
import { loadTemplateSnapshot } from "../../convert/template-loader.js";
import { EasyflowError, handleError } from "../../utils/errors.js";
import { StepProgress } from "../../utils/progress.js";

interface ConvertCliOptions {
  template: string;
  source?: string;
  output?: string;
  refs?: boolean;
}

const INFRA_REJECTION_MESSAGE =
  "infra は Agentfile 変換の対象外です（インフラエージェント自身の Fly.io デプロイ定義のため）";

function resolveSourceDir(template: string, explicit?: string): string {
  if (explicit) {
    return resolve(explicit);
  }

  const envDir = process.env.OPENCLAW_TEMPLATES_DIR;
  if (envDir) {
    return resolve(envDir, "templates", template);
  }

  const defaultDir = resolve(process.cwd(), "..", "openclaw-templates", "templates", template);
  if (existsSync(defaultDir)) {
    return defaultDir;
  }

  throw new EasyflowError(
    "変換元テンプレートディレクトリを解決できません",
    `--source 未指定、環境変数 OPENCLAW_TEMPLATES_DIR も未設定、既定パス (${defaultDir}) も存在しません`,
    "--source <dir> を指定するか、OPENCLAW_TEMPLATES_DIR 環境変数にテンプレート置き場（templates/ の親）を設定してください",
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printSummary(
  templateName: string,
  result: Awaited<ReturnType<typeof convertTemplateToAgentfile>>,
  outputPath: string | undefined,
): void {
  const lines: string[] = [];
  lines.push(`Converted '${templateName}' template → Agentfile`);
  lines.push("");

  const inputs = result.inputFiles.length > 0 ? result.inputFiles.join(", ") : "(なし)";
  lines.push(`  Inputs:  ${inputs}`);

  const tools = result.agentfile.tools?.builtin ?? [];
  lines.push(`  Tools:   ${tools.length > 0 ? tools.join(", ") : "(なし)"}`);

  const policyCount = result.agentfile.identity.policy?.length ?? 0;
  lines.push(`  Policy:  ${policyCount} 項目`);

  const warnings = result.warnings.length > 0 ? result.warnings.join(" / ") : "なし";
  lines.push(`  Warnings: ${warnings}`);
  lines.push("");

  if (outputPath) {
    const byteLength = Buffer.byteLength(result.yaml, "utf-8");
    lines.push(`Output: ${outputPath} (${formatSize(byteLength)})`);
  } else {
    lines.push("Output: <stdout>");
  }

  for (const line of lines) {
    console.error(line);
  }
}

export function registerConvertCommand(program: Command): void {
  program
    .command("convert")
    .description("既存テンプレートを Agentfile 形式に変換")
    .requiredOption("-t, --template <name>", "テンプレート名（monitor / executive-assistant）")
    .option("-s, --source <dir>", "変換元テンプレートディレクトリ（省略時は既定パス）")
    .option("-o, --output <path>", "出力先 YAML パス（省略時は標準出力）")
    .option("--no-refs", "agents_core.file / knowledge.sources を出力に含めない（バンドル配置用）")
    .action(async (options: ConvertCliOptions) => {
      try {
        if (options.template === "infra") {
          throw new EasyflowError(INFRA_REJECTION_MESSAGE);
        }

        const noColor = program.opts().color === false;
        const progress = new StepProgress(3, noColor);

        progress.start(1, "テンプレートを読み込み");
        const sourceDir = resolveSourceDir(options.template, options.source);
        if (!existsSync(sourceDir)) {
          progress.fail(`ディレクトリが存在しません: ${sourceDir}`);
          throw new EasyflowError(
            `変換元テンプレートディレクトリが見つかりません: ${sourceDir}`,
            undefined,
            "--source で正しいパスを指定してください",
          );
        }
        const snapshot = await loadTemplateSnapshot(sourceDir);
        progress.succeed(`source: ${sourceDir}`);

        progress.start(2, "Agentfile に変換");
        const result = await convertTemplateToAgentfile(snapshot, {
          templateName: options.template,
          omitFileRefs: options.refs === false,
        });
        progress.succeed();

        progress.start(3, options.output ? "YAML を書き出し" : "YAML を標準出力へ");
        if (options.output) {
          const absOutput = resolve(options.output);
          mkdirSync(dirname(absOutput), { recursive: true });
          writeFileSync(absOutput, result.yaml, "utf-8");
          progress.succeed(`→ ${absOutput}`);
          console.error("");
          printSummary(options.template, result, absOutput);
        } else {
          progress.succeed();
          process.stdout.write(result.yaml);
          console.error("");
          printSummary(options.template, result, undefined);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
