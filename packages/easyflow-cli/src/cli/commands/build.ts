import type { Command } from "commander";
import { ImageBuilder } from "../../image/builder.js";
import { ImageStore } from "../../store/image-store.js";
import { handleError } from "../../utils/errors.js";
import { StepProgress } from "../../utils/progress.js";

interface BuildCliOptions {
  file: string;
  tag: string;
  cache: boolean;
}

export function registerBuildCommand(program: Command): void {
  program
    .command("build")
    .description("Agentfile からエージェントイメージをビルド")
    .requiredOption("-f, --file <path>", "Agentfile のパス")
    .requiredOption("-t, --tag <ref>", "タグ付き ref（例: org/name:1.0）")
    .option("--no-cache", "ビルドキャッシュを無効化")
    .action(async (options: BuildCliOptions) => {
      try {
        const globalOpts = program.opts<{ noColor?: boolean; dryRun?: boolean }>();
        const noColor = globalOpts.noColor === true;
        const dryRun = globalOpts.dryRun === true;

        const store = new ImageStore();
        const builder = new ImageBuilder(store);
        const progress = new StepProgress(4, noColor);

        console.log("Building agent image...\n");

        // Step 1: Parsing Agentfile
        progress.start(1, "Parsing Agentfile");
        const plan = await builder.plan({
          agentfilePath: options.file,
          ref: options.tag,
        });
        const baseRef = plan.resolvedBase ?? plan.agentfile.base ?? "(none)";
        progress.succeed(`
      Base: ${baseRef}
      Name: ${plan.agentfile.metadata.name} v${plan.agentfile.metadata.version}`);

        // Step 2: Processing knowledge (Phase 1: empty)
        progress.start(2, "Processing knowledge");
        progress.succeed("(Phase 1 — knowledge empty)");

        // Step 3: Bundling tools & config
        progress.start(3, "Bundling tools & config");
        const toolsSummary = plan.builtinTools.length > 0 ? plan.builtinTools.join(", ") : "(none)";
        const channelsSummary = plan.channels.length > 0 ? plan.channels.join(", ") : "(none)";
        progress.succeed(`
      Tools: ${toolsSummary}
      Channels: ${channelsSummary}`);

        // Step 4: Creating image
        progress.start(4, "Creating image");
        if (dryRun) {
          const dryResult = await builder.build({
            agentfilePath: options.file,
            ref: options.tag,
            dryRun: true,
            noCache: !options.cache,
          });
          progress.succeed("(dry-run)");
          console.log(`\nDry-run: no image saved`);
          console.log(
            `Layers planned: ${dryResult.layers.map((l) => `${l.name}(${formatBytes(l.size)})`).join(", ")}`,
          );
          return;
        }

        const result = await builder.build({
          agentfilePath: options.file,
          ref: options.tag,
          noCache: !options.cache,
        });
        progress.succeed(`
      Digest: ${result.digest.slice(0, 19)}...
      Size:   ${formatBytes(result.size)}`);

        console.log(`\nSuccessfully built ${result.ref}`);
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
