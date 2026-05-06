import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Agentfile } from "../../agentfile/types.js";
import type { ImageData, StoredImage } from "../../store/types.js";
import { EasyflowError } from "../../utils/errors.js";
import { extractLayer } from "../layer-extractor.js";
import { buildOpenclawConfig } from "../openclaw-config.js";
import type { DeployAdapter, DeployOptions, DeployPlan, DeployResult } from "../types.js";
import type { FlyctlRunner } from "./flyctl.js";

const BASE_IMAGE =
  "ghcr.io/estack-inc/easy-flow-base@sha256:da7f2b41080943c65bbcd1e4448c69a10b80f82a179bd4beba3c298b07a12248";
const DEFAULT_REGION = "nrt";
const DEFAULT_ORG = "personal";
const DEPLOY_LAYER_NAMES = ["identity", "knowledge", "tools"] as const;
const DEFAULT_MODEL = "claude-sonnet-4-5";
const PROVIDER_SECRET_KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"] as const;
const FLY_DEPLOY_TIMEOUT_MS = 900_000;

/**
 * fly.toml テンプレートを生成する。
 * [build].image は使用せず Dockerfile ベースの local-only ビルドに切り替える。
 * app process 起動時に node スクリプトがプレースホルダを展開し /data に配置する。
 */
function buildFlyToml(appName: string, region: string): string {
  return `app = "${appName}"
primary_region = "${region}"

[env]
  NODE_ENV = "production"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=6144"
  OPENCLAW_NO_RESPAWN = "1"

[processes]
  app = "sh -lc 'mkdir -p /data && node /app/render-openclaw-config.js /app/openclaw.json.template /data/openclaw.json && exec /entrypoint.sh'"

[[mounts]]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [[http_service.checks]]
    grace_period = "120s"
    interval = "30s"
    method = "GET"
    path = "/health"
    timeout = "5s"

[[vm]]
  size = "shared-cpu-4x"
  memory = "8192mb"
`;
}

/**
 * エージェントレイヤーを焼き込む Dockerfile を生成する。
 * openclaw.json.template と render スクリプトを /app に配置し、
 * app process 起動時に node スクリプトがプレースホルダを展開して /data に書き出す。
 */
function buildDockerfile(): string {
  return `FROM --platform=linux/amd64 ${BASE_IMAGE}
COPY layers/identity/ /app/easyflow/identity/
COPY layers/knowledge/ /app/easyflow/knowledge/
COPY layers/tools/ /app/easyflow/tools/
COPY openclaw.json.template /app/openclaw.json.template
COPY render-openclaw-config.js /app/render-openclaw-config.js
`;
}

/**
 * Fly.io デプロイアダプター。
 */
export class FlyDeployAdapter implements DeployAdapter {
  readonly name = "fly" as const;

  constructor(
    private flyctl: FlyctlRunner,
    private log: (line: string) => void,
  ) {}

  async plan(
    stored: StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployPlan> {
    const region = options.region ?? DEFAULT_REGION;
    const org = options.org ?? DEFAULT_ORG;
    const app = options.app;

    let createApp = true;
    let createVolume = true;

    // dry-run でも read-only の存在確認は実行（正確な plan を表示するため）
    const appsOutput = await this.flyctl.apps(["list", "--json"]);
    const apps = this.parseAppsJson(appsOutput);
    createApp = !apps.includes(app);

    if (!createApp) {
      const volOutput = await this.flyctl.volumes(["list", "--app", app, "--json"]);
      const volumes = this.parseVolumesJson(volOutput);
      createVolume = !volumes.includes("data");
    }

    const resolvedSecrets = await this.resolveSecrets(agentfile, app, secrets, createApp);
    buildOpenclawConfig({
      agentfile,
      secrets,
      availableSecretKeys: resolvedSecrets.availableSecretKeys,
      agentId: app,
    });

    const channels: string[] = [];
    if (agentfile.channels?.slack?.enabled) channels.push("slack");
    if (agentfile.channels?.line?.enabled) channels.push("line");
    if (agentfile.channels?.webchat?.enabled) channels.push("webchat");

    const tools = agentfile.tools?.builtin ?? [];

    return {
      app,
      region,
      org,
      createApp,
      createVolume,
      image: {
        ref: stored.ref,
        digest: stored.digest,
        size: stored.size,
      },
      channels,
      tools,
      secretKeys: Array.from(resolvedSecrets.availableSecretKeys).sort(),
    };
  }

  async deploy(
    image: ImageData,
    stored: StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployResult> {
    const region = options.region ?? DEFAULT_REGION;
    const org = options.org ?? DEFAULT_ORG;
    const app = options.app;

    // Step 1: アプリ存在確認
    this.log(`[fly] アプリ確認: ${app}`);
    const appsOutput = await this.flyctl.apps(["list", "--json"]);
    const apps = this.parseAppsJson(appsOutput);
    const appExists = apps.includes(app);

    // Step 2: アプリ作成
    if (!appExists) {
      this.log(`[fly] アプリ作成: ${app} (org: ${org})`);
      await this.flyctl.apps(["create", app, "--org", org]);
    }

    // Step 3: ボリューム確認・作成
    const volOutput = await this.flyctl.volumes(["list", "--app", app, "--json"]);
    const volumes = this.parseVolumesJson(volOutput);
    const volumeExists = volumes.includes("data");

    if (!volumeExists) {
      this.log(`[fly] ボリューム作成: data (region: ${region})`);
      await this.flyctl.volumes([
        "create",
        "data",
        "--region",
        region,
        "--size",
        "1",
        "--app",
        app,
        "--yes",
      ]);
    }

    const resolvedSecrets = await this.resolveSecrets(agentfile, app, secrets, !appExists);

    // Step 4: ビルドコンテキストを一時ディレクトリに構築
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-deploy-"));
    try {
      // runtime に必要なレイヤーだけを展開して layers/<name>/ に配置する。
      // config レイヤーの Agentfile 系ファイルは secret を含み得るため、最終イメージへ同梱しない。
      for (const layerName of DEPLOY_LAYER_NAMES) {
        const layerBuf = image.layers.get(layerName);
        const layerDir = path.join(tmpDir, "layers", layerName);
        await fs.mkdir(layerDir, { recursive: true });
        if (layerBuf && layerBuf.length > 0) {
          const extracted = await extractLayer(layerBuf);
          for (const [fileName, { content, mode }] of extracted.files) {
            const filePath = path.join(layerDir, fileName);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, { mode });
          }
        }
      }

      // Dockerfile を生成（レイヤー + openclaw.json.template + render スクリプトを焼き込む）
      await fs.writeFile(path.join(tmpDir, "Dockerfile"), buildDockerfile(), "utf-8");

      // fly.toml を生成（app process 起動時に node スクリプトがプレースホルダを展開）
      await fs.writeFile(path.join(tmpDir, "fly.toml"), buildFlyToml(app, region), "utf-8");

      // openclaw.json.template を生成（チャネル認証情報はプレースホルダ、app process 起動時に展開）
      const openclawConfig = buildOpenclawConfig({
        agentfile,
        secrets,
        availableSecretKeys: resolvedSecrets.availableSecretKeys,
        agentId: app,
      });
      await fs.writeFile(
        path.join(tmpDir, "openclaw.json.template"),
        JSON.stringify(openclawConfig, null, 2),
        "utf-8",
      );

      // render-openclaw-config.js を生成（app process 起動時に呼ばれる）
      const renderScript = await fs.readFile(
        new URL("../render-openclaw-config.js", import.meta.url),
        "utf-8",
      );
      await fs.writeFile(path.join(tmpDir, "render-openclaw-config.js"), renderScript, "utf-8");

      // Step 5: シークレット設定（--stage でまずステージングに）
      // stdin 経由で渡してプロセス引数への平文露出を防ぐ
      const secretPairs: string[] = [];
      for (const [key, value] of Object.entries(resolvedSecrets.stagedSecrets)) {
        secretPairs.push(`${key}=${value}`);
      }
      if (secretPairs.length > 0) {
        this.log(`[fly] シークレット設定 (${secretPairs.length} 件)`);
        await this.flyctl.secretsImport(app, `${secretPairs.join("\n")}\n`, { stage: true });
      }

      // Step 6: デプロイ（tmpDir をビルドコンテキストとして flyctl に渡す）
      this.log(`[fly] デプロイ開始: ${app}`);
      await this.flyctl.deploy(
        app,
        ["--config", path.join(tmpDir, "fly.toml"), "--yes", "--local-only"],
        {
          cwd: tmpDir,
          timeoutMs: FLY_DEPLOY_TIMEOUT_MS,
        },
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    // Step 7: ヘルスチェック
    this.log(`[fly] ヘルスチェック実行中...`);
    const healthCheck = await this.pollHealthCheck(app);

    const url = `https://${app}.fly.dev`;
    const deployedAt = new Date().toISOString();

    return {
      app,
      target: "fly",
      ref: stored.ref,
      digest: stored.digest,
      url,
      deployedAt,
      healthCheck,
      knowledge:
        stored.metadata.knowledgeChunks !== undefined
          ? { chunks: stored.metadata.knowledgeChunks, namespace: `agent:${app}` }
          : undefined,
    };
  }

  private async pollHealthCheck(app: string): Promise<import("../types.js").HealthStatus> {
    const maxRetries = 18; // 90 秒 / 5 秒間隔
    const intervalMs = 5000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const start = Date.now();
        const output = await this.flyctl.ssh(app, [
          "curl",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://localhost:3000/health",
        ]);
        const latencyMs = Date.now() - start;
        const statusMatch = output.match(/(\d{3})\s*$/);
        const statusCode = statusMatch ? Number(statusMatch[1]) : Number.NaN;

        if (statusCode >= 200 && statusCode < 300) {
          return { ok: true, statusCode, latencyMs };
        }
      } catch {
        // リトライ
      }

      if (i < maxRetries - 1) {
        await sleep(intervalMs);
      }
    }

    return {
      ok: false,
      message: "ヘルスチェックがタイムアウトしました (90 秒)",
    };
  }

  private parseAppsJson(output: string): string[] {
    try {
      // JSON 部分を抽出して解析
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ Name?: string; name?: string }>;
      return parsed.map((a) => a.Name ?? a.name ?? "").filter(Boolean);
    } catch {
      // JSON でない場合はテキストパース
      const names: string[] = [];
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("NAME") && !trimmed.startsWith("-")) {
          const parts = trimmed.split(/\s+/);
          if (parts[0]) names.push(parts[0]);
        }
      }
      return names;
    }
  }

  private parseVolumesJson(output: string): string[] {
    try {
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ Name?: string; name?: string }>;
      return parsed.map((v) => v.Name ?? v.name ?? "").filter(Boolean);
    } catch {
      const names: string[] = [];
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("ID") && !trimmed.startsWith("-")) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) names.push(parts[1]);
        }
      }
      return names;
    }
  }

  private async resolveSecrets(
    agentfile: Agentfile,
    app: string,
    localSecrets: Record<string, string>,
    createApp: boolean,
  ): Promise<{
    availableSecretKeys: Set<string>;
    existingSecretKeys: Set<string>;
    stagedSecrets: Record<string, string>;
  }> {
    const existingSecretKeys = createApp ? new Set<string>() : await this.listSecretKeys(app);
    const stagedSecrets = { ...localSecrets };
    const availableSecretKeys = new Set<string>([
      ...existingSecretKeys,
      ...Object.keys(localSecrets),
    ]);

    if (!availableSecretKeys.has("GATEWAY_TOKEN")) {
      if (createApp) {
        stagedSecrets.GATEWAY_TOKEN = crypto.randomBytes(24).toString("hex");
        availableSecretKeys.add("GATEWAY_TOKEN");
      } else {
        throw new EasyflowError(
          "GATEWAY_TOKEN が見つかりません",
          "既存アプリの再デプロイでは GATEWAY_TOKEN を無言再生成できません",
          "--secret-file で GATEWAY_TOKEN を渡すか、Fly secrets に GATEWAY_TOKEN を設定してください",
        );
      }
    }

    const missingProviderSecrets = this.getRequiredProviderSecretKeys(agentfile).filter(
      (key) => !availableSecretKeys.has(key),
    );
    if (missingProviderSecrets.length > 0) {
      throw new EasyflowError(
        `provider secrets missing: ${missingProviderSecrets.join(", ")}`,
        "モデル設定に必要な LLM プロバイダーのキーが local secret-file / Fly secrets のどちらにも見つかりません",
        "--secret-file で不足分を渡すか、Fly secrets に設定してください",
      );
    }

    const missingRequired = this.getRequiredSecretKeys(agentfile).filter(
      (key) => !availableSecretKeys.has(key),
    );
    if (missingRequired.length > 0) {
      throw new EasyflowError(
        `required secrets missing: ${missingRequired.join(", ")}`,
        "必須シークレットが local secret-file / Fly secrets のどちらにも見つかりません",
        "--secret-file で不足分を渡すか、Fly secrets に設定してください",
      );
    }

    return {
      availableSecretKeys,
      existingSecretKeys,
      stagedSecrets,
    };
  }

  private getRequiredSecretKeys(agentfile: Agentfile): string[] {
    const required = ["GATEWAY_TOKEN"];
    if (agentfile.channels?.slack?.enabled) {
      required.push("SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET");
    }
    if (agentfile.channels?.line?.enabled) {
      required.push("LINE_ACCESS_TOKEN", "LINE_CHANNEL_SECRET");
    }
    if (agentfile.config?.rag?.enabled === true) {
      required.push("PINECONE_API_KEY");
    }
    return required;
  }

  private getRequiredProviderSecretKeys(agentfile: Agentfile): string[] {
    const models = [
      agentfile.config?.model?.default ?? DEFAULT_MODEL,
      agentfile.config?.model?.thinking,
    ].filter((model): model is string => typeof model === "string" && model.length > 0);

    const required = new Set<string>(["ANTHROPIC_API_KEY"]);
    for (const model of models) {
      const providerSecretKey = this.getProviderSecretKeyForModel(model);
      if (providerSecretKey) {
        required.add(providerSecretKey);
      }
    }

    if (required.size > 0) {
      return Array.from(required);
    }

    return ["ANTHROPIC_API_KEY"];
  }

  private getProviderSecretKeyForModel(
    model: string,
  ): (typeof PROVIDER_SECRET_KEYS)[number] | null {
    const normalized = model.trim().toLowerCase();

    if (normalized.startsWith("anthropic/") || normalized.includes("claude")) {
      return "ANTHROPIC_API_KEY";
    }

    if (normalized.startsWith("google/") || normalized.includes("gemini")) {
      return "GEMINI_API_KEY";
    }

    if (
      normalized.startsWith("openai/") ||
      normalized.startsWith("gpt-") ||
      normalized.startsWith("chatgpt-") ||
      /^o[134](?:-mini)?$/.test(normalized)
    ) {
      return "OPENAI_API_KEY";
    }

    return null;
  }

  private async listSecretKeys(app: string): Promise<Set<string>> {
    const output = await this.flyctl.secretsList(app);
    return new Set(this.parseSecretsJson(output));
  }

  private parseSecretsJson(output: string): string[] {
    try {
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ Name?: string; name?: string }>;
      return parsed.map((secret) => secret.Name ?? secret.name ?? "").filter(Boolean);
    } catch {
      const names: string[] = [];
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("NAME") && !trimmed.startsWith("-")) {
          const parts = trimmed.split(/\s+/);
          if (parts[0]) names.push(parts[0]);
        }
      }
      return names;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
