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
    const secrets: Array<{ Name?: string; name?: string }> = JSON.parse(result);
    const hasKey = secrets.some((s) => (s.Name || s.name) === "PINECONE_API_KEY");
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

  // python3 ではなく node を使用（全インスタンスで利用可能）
  // sh -c でラップして echo | base64 -d | node のパイプを有効化
  const nodeScript = `
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/data/openclaw.json', 'utf8'));
if (!d.plugins) d.plugins = {};
if (!d.plugins['pinecone-memory']) d.plugins['pinecone-memory'] = {};
Object.assign(d.plugins['pinecone-memory'], ${JSON.stringify(pluginConfig)});
fs.writeFileSync('/data/openclaw.json', JSON.stringify(d, null, 2));
console.log('done');
  `.trim();

  const b64 = Buffer.from(nodeScript).toString("base64");
  runner.exec(`fly ssh console -a ${instance.flyApp} -C "sh -c 'echo ${b64} | base64 -d | node'"`);
}

async function runMigrateMemory(
  instance: InstanceConfig,
  apiKey: string,
  dryRun: boolean,
  runner: CommandRunner,
): Promise<void> {
  const sourceArgs = instance.sources.map((s) => `--source ${s}`).join(" ");
  const excludeArgs = instance.excludePatterns.map((p) => `--exclude-pattern ${p}`).join(" ");
  const dryRunFlag = dryRun ? "--dry-run" : "";

  // easy-flow-agent が存在しない場合は自動インストールする
  await ensureEasyFlowAgent(instance, dryRun, runner);

  // sh -c でラップして環境変数を正しく渡す
  const innerCmd = `PINECONE_API_KEY=${apiKey} /usr/local/lib/node_modules/openclaw/node_modules/.bin/jiti /data/easy-flow-agent/packages/migrate-memory/src/cli.ts migrate-memory --agent-id ${instance.agentId} ${sourceArgs} ${excludeArgs} ${dryRunFlag}`;
  const cmd = `fly ssh console -a ${instance.flyApp} -C "sh -c '${innerCmd}'"`;

  console.log(`Running migrate-memory for ${instance.name}...`);
  if (dryRun) {
    console.log(`[DRY RUN] ${cmd}`);
    return;
  }
  runner.exec(cmd, { stdio: "inherit" });
}

/**
 * 対象インスタンスに /data/easy-flow-agent が存在しない場合、
 * GitHub からクローンして npm install を実行する。
 */
async function ensureEasyFlowAgent(
  instance: InstanceConfig,
  dryRun: boolean,
  runner: CommandRunner,
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY RUN] Would ensure easy-flow-agent is installed on ${instance.flyApp}`);
    return;
  }

  // /data/easy-flow-agent が存在するか確認
  try {
    runner.exec(`fly ssh console -a ${instance.flyApp} -C "sh -c 'test -d /data/easy-flow-agent'"`);
    console.log(`${instance.name}: easy-flow-agent already installed`);
    return;
  } catch {
    // 存在しない場合はインストールへ
  }

  console.log(`${instance.name}: Installing easy-flow-agent...`);

  // GH_TOKEN を取得（gh CLI から → mell-dev secrets → 環境変数 の順で試行）
  let ghToken = "";
  try {
    ghToken = runner.exec("gh auth token").trim();
  } catch {
    try {
      ghToken = runner
        .exec(`fly ssh console -a mell-dev -C "sh -c 'printenv GH_TOKEN || printenv GITHUB_TOKEN'"`)
        .trim();
    } catch {
      ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
    }
  }

  if (!ghToken) {
    throw new Error(
      `easy-flow-agent のインストールに必要な GH_TOKEN が取得できませんでした。` +
        `fly secrets set GH_TOKEN=<PAT> --app ${instance.flyApp} を実行してから再試行してください。`,
    );
  }

  // git clone
  runner.exec(
    `fly ssh console -a ${instance.flyApp} -C "sh -c 'cd /data && git clone https://x:${ghToken}@github.com/estack-inc/easy-flow-agent.git easy-flow-agent'"`,
    { stdio: "inherit" },
  );

  // npm install（--omit=dev で本番パッケージのみ）
  runner.exec(
    `fly ssh console -a ${instance.flyApp} -C "sh -c 'cd /data/easy-flow-agent && npm install --omit=dev 2>&1 | tail -5'"`,
    { stdio: "inherit" },
  );

  console.log(`${instance.name}: easy-flow-agent installed`);
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
  // sh -c でラップし、node スクリプトを base64 経由で渡す
  // （fly ssh console -C はシェルを介さないため cd && node 等の複合コマンドが使えない）
  const smokeScript = `
const {Pinecone}=require('/data/easy-flow-agent/node_modules/@pinecone-database/pinecone');
new Pinecone({apiKey:process.env.PINECONE_API_KEY})
  .index(${JSON.stringify(instance.index)})
  .describeIndexStats()
  .then(s=>console.log(JSON.stringify(s.namespaces)))
  .catch(e=>console.error(e.message));
  `.trim();
  const b64 = Buffer.from(smokeScript).toString("base64");
  const cmd = `fly ssh console -a ${instance.flyApp} -C "sh -c 'echo ${b64} | base64 -d | node'"`;
  const result = runner.exec(cmd);
  console.log(`Smoke test result for ${instance.name}:`, result);
}
