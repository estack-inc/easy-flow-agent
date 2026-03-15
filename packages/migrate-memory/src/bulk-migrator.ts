import { execSync } from "node:child_process";
import * as fs from "node:fs";

export interface InstanceConfig {
  name: string;
  flyApp: string;
  agentId: string;
  index: string;
  sources: string[];
  excludePatterns: string[];
  memoryHint?: string;
}

export interface BulkMigrateConfig {
  instances: InstanceConfig[];
  compactAfterDays: number;
}

export interface BulkMigrateOptions {
  configPath: string;
  dryRun: boolean;
  targetInstance?: string;
}

export interface CommandRunner {
  exec(cmd: string, options?: { stdio?: "inherit" }): string;
  readFile(path: string): string;
}

const defaultRunner: CommandRunner = {
  exec(cmd: string, options?: { stdio?: "inherit" }): string {
    return execSync(cmd, options as Parameters<typeof execSync>[1])?.toString() ?? "";
  },
  readFile(path: string): string {
    return fs.readFileSync(path, "utf-8");
  },
};

export interface BulkMigrateResult {
  processed: number;
  failed: number;
}

export async function bulkMigrate(
  options: BulkMigrateOptions,
  runner: CommandRunner = defaultRunner,
): Promise<BulkMigrateResult> {
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
    return { processed: 0, failed: 1 };
  }

  let failed = 0;
  let processed = 0;

  for (const instance of targets) {
    console.log(`\n=== Processing: ${instance.name} ===`);

    const apiKey = getApiKeyFromFly(instance.flyApp, options.dryRun, runner);
    if (!apiKey && !options.dryRun) {
      console.error(`PINECONE_API_KEY not set for ${instance.flyApp}`);
      failed++;
      continue;
    }

    try {
      await configurePineconePlugin(instance, config.compactAfterDays, options.dryRun, runner);
      await runMigrateMemory(instance, apiKey, options.dryRun, runner);
      await runSmokeTest(instance, options.dryRun, runner);
      console.log(`${instance.name}: migration complete`);
      processed++;
    } catch (err) {
      console.error(
        `${instance.name}: migration failed:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  return { processed, failed };
}

function getApiKeyFromFly(flyApp: string, dryRun: boolean, runner: CommandRunner): string {
  if (dryRun) return "DRY_RUN_API_KEY";
  try {
    const result = runner.exec(`fly secrets list -a ${flyApp} --json`);
    const secrets: Array<{ Name: string }> = JSON.parse(result);
    const hasKey = secrets.some((s) => s.Name === "PINECONE_API_KEY");
    if (!hasKey) return "";
    return runner.exec(`fly ssh console -a ${flyApp} -C "printenv PINECONE_API_KEY"`).trim();
  } catch {
    return "";
  }
}

async function configurePineconePlugin(
  instance: InstanceConfig,
  compactAfterDays: number,
  dryRun: boolean,
  runner: CommandRunner,
): Promise<void> {
  const pluginConfig = {
    agentId: instance.agentId,
    index: instance.index,
    compactAfterDays,
  };

  if (dryRun) {
    console.log(
      `[DRY RUN] Would configure pinecone-memory plugin for ${instance.name}:`,
      pluginConfig,
    );
    return;
  }

  const script = `
import json
with open('/data/openclaw.json', 'r') as f:
    d = json.load(f)
d.setdefault('plugins', {}).setdefault('pinecone-memory', {}).update(${JSON.stringify(pluginConfig)})
with open('/data/openclaw.json', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('done')
  `.trim();

  const b64 = Buffer.from(script).toString("base64");
  runner.exec(`fly ssh console -a ${instance.flyApp} -C "echo '${b64}' | base64 -d | python3"`);
}

async function runMigrateMemory(
  instance: InstanceConfig,
  apiKey: string,
  dryRun: boolean,
  runner: CommandRunner,
): Promise<void> {
  const sourceArgs = instance.sources.map((s) => `--source ${s}`).join(" ");
  const excludeArgs = instance.excludePatterns.map((p) => `--exclude-pattern '${p}'`).join(" ");
  const dryRunFlag = dryRun ? "--dry-run" : "";

  const cmd = `fly ssh console -a ${instance.flyApp} -C "PINECONE_API_KEY=${apiKey} /usr/local/lib/node_modules/openclaw/node_modules/.bin/jiti /data/easy-flow-agent/packages/migrate-memory/src/cli.ts migrate-memory --agent-id ${instance.agentId} ${sourceArgs} ${excludeArgs} ${dryRunFlag}"`;

  console.log(`Running migrate-memory for ${instance.name}...`);
  if (dryRun) {
    console.log(`[DRY RUN] ${cmd}`);
    return;
  }
  runner.exec(cmd, { stdio: "inherit" });
}

async function runSmokeTest(
  instance: InstanceConfig,
  dryRun: boolean,
  runner: CommandRunner,
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY RUN] Would run smoke test for ${instance.name}`);
    return;
  }
  const cmd = `fly ssh console -a ${instance.flyApp} -C "cd /data/easy-flow-agent && node -e \\"const {Pinecone}=require('./node_modules/@pinecone-database/pinecone');new Pinecone({apiKey:process.env.PINECONE_API_KEY}).index('${instance.index}').describeIndexStats().then(s=>console.log(JSON.stringify(s.namespaces))).catch(e=>console.error(e.message))\\""`;
  const result = runner.exec(cmd);
  console.log(`Smoke test result for ${instance.name}:`, result);
}
