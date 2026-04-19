import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Agentfile } from "../../agentfile/types.js";
import type { ImageData, StoredImage } from "../../store/types.js";
import { extractLayer } from "../layer-extractor.js";
import { buildOpenclawConfig } from "../openclaw-config.js";
import type { DeployAdapter, DeployOptions, DeployPlan, DeployResult } from "../types.js";
import type { FlyctlRunner } from "./flyctl.js";

const BASE_IMAGE = "ghcr.io/openclaw/openclaw:latest";
const DEFAULT_REGION = "nrt";
const DEFAULT_ORG = "personal";
const LAYER_NAMES = ["identity", "knowledge", "tools", "config"] as const;

/**
 * fly.toml テンプレートを生成する。
 * [build].image は使用せず Dockerfile ベースのリモートビルドに切り替える。
 * release_command で /app/openclaw.json を /data に配置し、デプロイごとに最新設定を反映する。
 */
function buildFlyToml(appName: string, region: string): string {
  return `app = "${appName}"
primary_region = "${region}"

release_command = "cp /app/openclaw.json /data/openclaw.json"

[[mounts]]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  [[http_service.checks]]
    grace_period = "30s"
    interval = "15s"
    method = "GET"
    path = "/gateway/status"
    timeout = "10s"
`;
}

/**
 * エージェントレイヤーを焼き込む Dockerfile を生成する。
 * openclaw.json は /app/openclaw.json に配置し、release_command で /data にコピーする。
 */
function buildDockerfile(): string {
  return `FROM ${BASE_IMAGE}
COPY layers/identity/ /app/easyflow/identity/
COPY layers/knowledge/ /app/easyflow/knowledge/
COPY layers/tools/ /app/easyflow/tools/
COPY layers/config/ /app/easyflow/config/
COPY openclaw.json /app/openclaw.json
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
  ): Promise<DeployPlan> {
    const region = options.region ?? DEFAULT_REGION;
    const org = options.org ?? DEFAULT_ORG;
    const app = options.app;

    let createApp = true;
    let createVolume = true;

    // dry-run でも read-only の存在確認は実行（正確な plan を表示するため）
    try {
      const appsOutput = await this.flyctl.apps(["list", "--json"]);
      const apps = this.parseAppsJson(appsOutput);
      createApp = !apps.includes(app);
    } catch {
      // flyctl が使えない場合は新規とみなす
    }

    if (!createApp) {
      try {
        const volOutput = await this.flyctl.volumes(["list", "--app", app, "--json"]);
        const volumes = this.parseVolumesJson(volOutput);
        createVolume = !volumes.includes("data");
      } catch {
        // ボリューム確認失敗 → 新規とみなす
      }
    }

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
      secretKeys: [],
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
    let appExists = false;
    try {
      const appsOutput = await this.flyctl.apps(["list", "--json"]);
      const apps = this.parseAppsJson(appsOutput);
      appExists = apps.includes(app);
    } catch {
      // flyctl エラーは上位に伝播
    }

    // Step 2: アプリ作成
    if (!appExists) {
      this.log(`[fly] アプリ作成: ${app} (org: ${org})`);
      await this.flyctl.apps(["create", app, "--org", org]);
    }

    // Step 3: ボリューム確認・作成
    let volumeExists = false;
    try {
      const volOutput = await this.flyctl.volumes(["list", "--app", app, "--json"]);
      const volumes = this.parseVolumesJson(volOutput);
      volumeExists = volumes.includes("data");
    } catch {
      // ignore
    }

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
      ]);
    }

    // Step 4: ビルドコンテキストを一時ディレクトリに構築
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-deploy-"));
    try {
      // 各レイヤーを展開して layers/<name>/ に配置
      for (const layerName of LAYER_NAMES) {
        const layerBuf = image.layers.get(layerName);
        const layerDir = path.join(tmpDir, "layers", layerName);
        await fs.mkdir(layerDir, { recursive: true });
        if (layerBuf && layerBuf.length > 0) {
          const extracted = await extractLayer(layerBuf);
          for (const [fileName, content] of extracted.files) {
            const filePath = path.join(layerDir, fileName);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content);
          }
        }
      }

      // Dockerfile を生成（レイヤー + openclaw.json を焼き込む）
      await fs.writeFile(path.join(tmpDir, "Dockerfile"), buildDockerfile(), "utf-8");

      // fly.toml を生成（release_command で /data/openclaw.json を更新）
      await fs.writeFile(path.join(tmpDir, "fly.toml"), buildFlyToml(app, region), "utf-8");

      // openclaw.json を生成（release_command が /app -> /data にコピーする）
      const openclawConfig = buildOpenclawConfig({ agentfile, secrets });
      await fs.writeFile(
        path.join(tmpDir, "openclaw.json"),
        JSON.stringify(openclawConfig, null, 2),
        "utf-8",
      );

      // Step 5: シークレット設定（--stage でまずステージングに）
      const secretPairs: string[] = [];
      for (const [key, value] of Object.entries(secrets)) {
        secretPairs.push(`${key}=${value}`);
      }
      if (secretPairs.length > 0) {
        this.log(`[fly] シークレット設定 (${secretPairs.length} 件)`);
        await this.flyctl.secrets(["set", ...secretPairs, "--app", app, "--stage"]);
      }

      // Step 6: デプロイ（tmpDir をビルドコンテキストとして flyctl に渡す）
      this.log(`[fly] デプロイ開始: ${app}`);
      await this.flyctl.deploy(app, ["--config", path.join(tmpDir, "fly.toml")], {
        cwd: tmpDir,
        timeoutMs: 300_000,
      });
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
          ? { chunks: stored.metadata.knowledgeChunks, namespace: app }
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
          "http://localhost:3000/gateway/status",
        ]);
        const latencyMs = Date.now() - start;
        const statusCode = parseInt(output.trim(), 10);

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
