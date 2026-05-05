import type { Command } from "commander";
import { FlyDeployAdapter } from "../../deploy/adapters/fly.js";
import { FlyctlRunner } from "../../deploy/adapters/flyctl.js";
import { Deployer } from "../../deploy/deployer.js";
import { DeploymentsLog } from "../../deploy/deployments-log.js";
import type { DeployAdapter } from "../../deploy/types.js";
import { ImageStore } from "../../store/image-store.js";
import { handleError } from "../../utils/errors.js";
import { StepProgress } from "../../utils/progress.js";

interface DeployCliOptions {
  target: string;
  app: string;
  region?: string;
  org?: string;
  secretFile?: string;
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy <ref>")
    .description("エージェントイメージをクラウドにデプロイ")
    .requiredOption("--app <name>", "デプロイ先のアプリ名")
    .option("--target <platform>", "デプロイターゲット (fly)", "fly")
    .option("--region <region>", "デプロイリージョン (例: nrt)")
    .option("--org <org>", "Fly.io 組織名")
    .option("--secret-file <path>", "シークレットファイルのパス (.env 形式)")
    .action(async (ref: string, options: DeployCliOptions) => {
      try {
        const globalOpts = program.opts<{ noColor?: boolean; dryRun?: boolean }>();
        const noColor = globalOpts.noColor === true;
        const dryRun = globalOpts.dryRun === true;

        if (options.target !== "fly") {
          console.error(
            `Error: 未サポートのターゲット: ${options.target}（現在は 'fly' のみ対応）`,
          );
          process.exit(1);
        }

        const logLines: string[] = [];
        const logFn = (line: string): void => {
          logLines.push(line);
        };

        const store = new ImageStore();
        const flyctl = new FlyctlRunner(logFn);
        const flyAdapter = new FlyDeployAdapter(flyctl, logFn);
        const adapters = new Map<"fly", DeployAdapter>([["fly", flyAdapter]]);
        const deploymentsLog = new DeploymentsLog();
        const deployer = new Deployer(store, adapters, deploymentsLog);

        const progress = new StepProgress(5, noColor);

        if (dryRun) {
          console.log("Deployment plan (dry-run):\n");

          progress.start(1, "イメージ確認");
          const plan = await deployer.plan({
            ref,
            target: "fly",
            app: options.app,
            region: options.region,
            org: options.org,
            secretFile: options.secretFile,
            dryRun: true,
          });
          progress.succeed(`ref=${plan.image.ref}`);

          progress.start(2, "アプリ・ボリューム確認");
          progress.succeed(`createApp=${plan.createApp}, createVolume=${plan.createVolume}`);

          progress.start(3, "設定生成");
          progress.succeed(
            `channels=${plan.channels.join(",") || "(none)"}, tools=${plan.tools.join(",") || "(none)"}`,
          );

          progress.start(4, "シークレット設定");
          progress.succeed("(dry-run — スキップ)");

          progress.start(5, "デプロイ");
          progress.succeed("(dry-run — スキップ)");

          console.log(`\nDry-run: デプロイは実行されませんでした`);
          console.log(`App:    ${plan.app}`);
          console.log(`Region: ${plan.region}`);
          console.log(`Org:    ${plan.org}`);
          console.log(`Image:  ${plan.image.ref} (${plan.image.digest.slice(0, 19)}...)`);
          return;
        }

        console.log(`Deploying ${ref} to ${options.target}...\n`);

        progress.start(1, "イメージ確認");
        // load を試みて存在確認
        const imageData = await store.load(ref);
        if (!imageData) {
          progress.fail(`イメージが見つかりません: ${ref}`);
          process.exit(1);
        }
        progress.succeed(`ref=${ref}`);

        progress.start(2, "アプリ・ボリューム確認");
        const plan = await deployer.plan({
          ref,
          target: "fly",
          app: options.app,
          region: options.region,
          org: options.org,
          secretFile: options.secretFile,
        });
        progress.succeed(`createApp=${plan.createApp}, createVolume=${plan.createVolume}`);

        progress.start(3, "設定生成・シークレット設定・デプロイ・ヘルスチェック");
        const result = await deployer.deploy({
          ref,
          target: "fly",
          app: options.app,
          region: options.region,
          org: options.org,
          secretFile: options.secretFile,
        });

        progress.succeed(
          result.healthCheck.ok
            ? `ok (${result.healthCheck.latencyMs ?? 0}ms)`
            : `warn: ${result.healthCheck.message ?? "ヘルスチェック失敗"}`,
        );

        console.log(`\nSuccessfully deployed ${result.ref}`);
        console.log(`URL:       ${result.url}`);
        console.log(`App:       ${result.app}`);
        console.log(`Digest:    ${result.digest.slice(0, 19)}...`);
        console.log(`DeployedAt: ${result.deployedAt}`);

        if (!result.healthCheck.ok) {
          console.warn(
            `\n警告: ヘルスチェックが成功しませんでした。アプリのログを確認してください。`,
          );
        }
      } catch (error) {
        handleError(error);
      }
    });
}
