import type { BulkMigrateConfig, CommandRunner } from "./bulk-migrator.js";
import { defaultRunner } from "./bulk-migrator.js";

export interface BulkUpdateOptions {
  configPath: string;
  dryRun: boolean;
  targetInstance?: string;
}

export interface BulkUpdateResult {
  updated: number;
  failed: number;
}

const UPDATE_COMMANDS = [
  "cd /data/easy-flow-agent && git pull --ff-only origin main",
  "cd /data/easy-flow-agent && npm install --omit=dev --ignore-scripts",
  "cd /data/easy-flow-agent && npm run build --workspace=packages/openclaw-pinecone-plugin",
];

export async function bulkUpdate(
  options: BulkUpdateOptions,
  runner: CommandRunner = defaultRunner,
): Promise<BulkUpdateResult> {
  const config: BulkMigrateConfig = JSON.parse(runner.readFile(options.configPath));

  const targets = options.targetInstance
    ? config.instances.filter((i) => i.name === options.targetInstance)
    : config.instances;

  if (targets.length === 0) {
    console.error(
      options.targetInstance
        ? `No instance found with name: ${options.targetInstance}`
        : "No instances configured",
    );
    return { updated: 0, failed: 1 };
  }

  let updated = 0;
  let failed = 0;

  for (const instance of targets) {
    console.log(`\n=== Updating: ${instance.name} (${instance.flyApp}) ===`);

    try {
      // Step 1-3: git pull, npm install, npm run build
      for (const innerCmd of UPDATE_COMMANDS) {
        const cmd = `fly ssh console -a ${instance.flyApp} -C "sh -c '${innerCmd}'"`;
        if (options.dryRun) {
          console.log(`[DRY RUN] ${cmd}`);
        } else {
          console.log(`> ${innerCmd}`);
          runner.exec(cmd, { stdio: "inherit" });
        }
      }

      // Step 4: Restart gateway
      const restartCmd = `fly machine restart -a ${instance.flyApp}`;
      if (options.dryRun) {
        console.log(`[DRY RUN] ${restartCmd}`);
      } else {
        console.log(`> Restarting ${instance.flyApp}...`);
        runner.exec(restartCmd, { stdio: "inherit" });
      }

      console.log(`${instance.name}: update complete`);
      updated++;
    } catch (err) {
      console.error(
        `${instance.name}: update failed:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  return { updated, failed };
}
