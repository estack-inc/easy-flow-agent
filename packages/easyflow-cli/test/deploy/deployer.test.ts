import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agentfile } from "../../src/agentfile/types.js";
import { Deployer } from "../../src/deploy/deployer.js";
import { DeploymentsLog } from "../../src/deploy/deployments-log.js";
import type {
  DeployAdapter,
  DeployOptions,
  DeployPlan,
  DeployResult,
} from "../../src/deploy/types.js";
import { ImageBuilder } from "../../src/image/builder.js";
import { ImageStore } from "../../src/store/image-store.js";
import { EasyflowError } from "../../src/utils/errors.js";

const MINIMAL_AGENTFILE_YAML = `
apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: 1.0.0
  description: Test
  author: test
identity:
  name: TestAgent
  soul: You are helpful.
`.trim();

async function createMockConfigLayer(
  agentfileYaml: string,
  resolvedAgentfile?: Agentfile,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-deployer-test-"));
  try {
    // ImageBuilder は config レイヤー内のファイルを "Agentfile" という名前で保存する
    await fs.writeFile(path.join(tmpDir, "Agentfile"), agentfileYaml, "utf-8");
    const entries = ["Agentfile"];
    if (resolvedAgentfile) {
      await fs.writeFile(
        path.join(tmpDir, "Agentfile.resolved.json"),
        `${JSON.stringify(resolvedAgentfile, null, 2)}\n`,
        "utf-8",
      );
      entries.push("Agentfile.resolved.json");
    }

    const chunks: Buffer[] = [];
    const stream = tar.create({ gzip: true, cwd: tmpDir, portable: true }, entries);
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

class MockAdapter implements DeployAdapter {
  readonly name = "fly" as const;
  deployCalledWith: {
    agentfile: Agentfile;
    options: DeployOptions;
    secrets: Record<string, string>;
  } | null = null;
  planCalledWith: {
    agentfile: Agentfile;
    options: DeployOptions;
    secrets: Record<string, string>;
  } | null = null;
  healthCheck: DeployResult["healthCheck"] = { ok: true, statusCode: 200, latencyMs: 100 };

  async deploy(
    _image: import("../../src/store/types.js").ImageData,
    stored: import("../../src/store/types.js").StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployResult> {
    this.deployCalledWith = { agentfile, options, secrets };
    return {
      app: options.app,
      target: "fly",
      ref: stored.ref,
      digest: stored.digest,
      url: `https://${options.app}.fly.dev`,
      deployedAt: new Date().toISOString(),
      healthCheck: this.healthCheck,
    };
  }

  async plan(
    stored: import("../../src/store/types.js").StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployPlan> {
    this.planCalledWith = { agentfile, options, secrets };
    return {
      app: options.app,
      region: options.region ?? "nrt",
      org: options.org ?? "personal",
      createApp: true,
      createVolume: true,
      image: { ref: stored.ref, digest: stored.digest, size: stored.size },
      channels: [],
      tools: [],
      secretKeys: Object.keys(secrets),
    };
  }
}

describe("Deployer", () => {
  let tmpDir: string;
  let storeDir: string;
  let logFile: string;
  let store: ImageStore;
  let deploymentsLog: DeploymentsLog;
  let mockAdapter: MockAdapter;
  let deployer: Deployer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-deployer-test-"));
    storeDir = path.join(tmpDir, "store");
    logFile = path.join(tmpDir, "deployments.json");

    store = new ImageStore(storeDir);
    deploymentsLog = new DeploymentsLog(logFile);
    mockAdapter = new MockAdapter();
    deployer = new Deployer(store, new Map([["fly", mockAdapter]]), deploymentsLog);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("イメージが存在しない場合 EasyflowError をスローする", async () => {
    await expect(
      deployer.deploy({
        ref: "test/agent:1.0",
        target: "fly",
        app: "test-app",
      }),
    ).rejects.toThrow(EasyflowError);
  });

  it("未サポートのターゲットで EasyflowError をスローする", async () => {
    const configLayer = await createMockConfigLayer(MINIMAL_AGENTFILE_YAML);
    await store.save("test/agent:1.0", {
      manifest: {},
      config: {},
      layers: new Map([["config", configLayer]]),
    });

    // "gcp" は未サポート
    const adapters = new Map<"fly", DeployAdapter>();
    const deployerNoTarget = new Deployer(store, adapters, deploymentsLog);

    await expect(
      deployerNoTarget.deploy({
        ref: "test/agent:1.0",
        target: "fly",
        app: "test-app",
      }),
    ).rejects.toThrow(EasyflowError);
  });

  it("正常デプロイフロー: アダプターが呼ばれ履歴が記録される", async () => {
    const configLayer = await createMockConfigLayer(MINIMAL_AGENTFILE_YAML);
    await store.save("test/agent:1.0", {
      manifest: {},
      config: {},
      layers: new Map([["config", configLayer]]),
    });

    const result = await deployer.deploy({
      ref: "test/agent:1.0",
      target: "fly",
      app: "my-app",
    });

    expect(result.app).toBe("my-app");
    expect(result.target).toBe("fly");
    expect(result.healthCheck.ok).toBe(true);
    expect(mockAdapter.deployCalledWith).not.toBeNull();

    // デプロイ履歴が記録されたことを確認
    const entries = await deploymentsLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].app).toBe("my-app");
    // namespace は Fly アプリ名ではなく Agentfile の metadata.name をもとに計算する
    expect(entries[0].knowledge.namespace).toBe("agent:test-agent");
  });

  it("ヘルスチェック失敗時は履歴を記録せず EasyflowError をスローする", async () => {
    const configLayer = await createMockConfigLayer(MINIMAL_AGENTFILE_YAML);
    await store.save("test/agent:health-fail", {
      manifest: {},
      config: {},
      layers: new Map([["config", configLayer]]),
    });
    mockAdapter.healthCheck = { ok: false, message: "gateway status timeout" };

    await expect(
      deployer.deploy({
        ref: "test/agent:health-fail",
        target: "fly",
        app: "health-fail-app",
      }),
    ).rejects.toThrow("deploy health check failed");

    const entries = await deploymentsLog.list();
    expect(entries).toHaveLength(0);
  });

  it("plan() でアダプターの plan が呼ばれる", async () => {
    const configLayer = await createMockConfigLayer(MINIMAL_AGENTFILE_YAML);
    await store.save("test/agent:1.0", {
      manifest: {},
      config: {},
      layers: new Map([["config", configLayer]]),
    });

    const plan = await deployer.plan({
      ref: "test/agent:1.0",
      target: "fly",
      app: "my-app",
    });

    expect(plan.app).toBe("my-app");
    expect(plan.createApp).toBe(true);
  });

  it("Agentfile.resolved.json があれば raw Agentfile を再パースせず利用する", async () => {
    const rawAgentfileWithoutTools = MINIMAL_AGENTFILE_YAML;
    const resolvedAgentfile: Agentfile = {
      apiVersion: "easyflow/v1",
      kind: "Agent",
      metadata: {
        name: "test-agent",
        version: "1.0.0",
        description: "Test",
        author: "test",
      },
      identity: {
        name: "TestAgent",
        soul: "You are helpful.",
      },
      tools: { builtin: ["workflow-controller"] },
    };
    const configLayer = await createMockConfigLayer(rawAgentfileWithoutTools, resolvedAgentfile);
    await store.save("test/agent:resolved", {
      manifest: {},
      config: {},
      layers: new Map([["config", configLayer]]),
    });

    await deployer.plan({
      ref: "test/agent:resolved",
      target: "fly",
      app: "resolved-app",
    });

    expect(mockAdapter.planCalledWith?.agentfile.tools?.builtin).toEqual(["workflow-controller"]);
  });

  it("ImageBuilder.build() の実出力から Agentfile を正しく取得できる（回帰）", async () => {
    const agentfilePath = path.join(tmpDir, "Agentfile");
    await fs.writeFile(agentfilePath, MINIMAL_AGENTFILE_YAML, "utf-8");

    const builder = new ImageBuilder(store);
    await builder.build({ agentfilePath, ref: "test/agent:builder" });

    // 実ビルド成果物を使って plan() が Agentfile を読めることを検証
    const plan = await deployer.plan({
      ref: "test/agent:builder",
      target: "fly",
      app: "builder-app",
    });

    expect(plan.app).toBe("builder-app");
  });

  it("ビルド済みイメージはソースファイルが存在しなくても plan() が成功する", async () => {
    // knowledge.sources / agents_core.file / tools.custom を含む Agentfile
    const agentfileWithPaths = `
apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: 1.0.0
  description: Test
  author: test
identity:
  name: TestAgent
  soul: You are helpful.
agents_core:
  file: ./AGENTS-CORE.md
knowledge:
  sources:
    - path: ./docs
      type: agents_rule
      description: docs
tools:
  custom:
    - name: custom-tool
      path: ./tools/custom.js
`.trim();

    // ビルド時に必要なファイルを一時作成
    const buildDir = path.join(tmpDir, "build-source");
    await fs.mkdir(buildDir, { recursive: true });
    await fs.mkdir(path.join(buildDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(buildDir, "tools"), { recursive: true });
    await fs.writeFile(path.join(buildDir, "Agentfile"), agentfileWithPaths, "utf-8");
    await fs.writeFile(path.join(buildDir, "AGENTS-CORE.md"), "# Core", "utf-8");
    await fs.writeFile(path.join(buildDir, "docs", "guide.md"), "# Guide", "utf-8");
    await fs.writeFile(path.join(buildDir, "tools", "custom.js"), "// tool", "utf-8");

    // ビルド
    const builder = new ImageBuilder(store);
    await builder.build({
      agentfilePath: path.join(buildDir, "Agentfile"),
      ref: "test/agent:paths",
    });

    // ソースツリーを削除
    await fs.rm(buildDir, { recursive: true, force: true });

    // ソースファイルが存在しない状態で plan() が成功することを検証
    const plan = await deployer.plan({
      ref: "test/agent:paths",
      target: "fly",
      app: "paths-app",
    });

    expect(plan.app).toBe("paths-app");
    expect(plan.createApp).toBe(true);
  });

  describe("plan() シークレット受け渡し", () => {
    it("secretFile の値を adapter.plan() に渡す", async () => {
      const agentfileWithSlack = `
apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: 1.0.0
  description: Test
  author: test
identity:
  name: TestAgent
  soul: You are helpful.
channels:
  slack:
    enabled: true
`.trim();

      const configLayer = await createMockConfigLayer(agentfileWithSlack);
      await store.save("test/agent:slack-ok", {
        manifest: {},
        config: {},
        layers: new Map([["config", configLayer]]),
      });

      // シークレットファイルを作成
      const secretFile = path.join(tmpDir, "secrets.env");
      await fs.writeFile(secretFile, "SLACK_BOT_TOKEN=xoxb-test-token\n");

      const plan = await deployer.plan({
        ref: "test/agent:slack-ok",
        target: "fly",
        app: "slack-ok-app",
        secretFile,
      });

      expect(plan.app).toBe("slack-ok-app");
      expect(mockAdapter.planCalledWith?.secrets.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
      expect(plan.secretKeys).toContain("SLACK_BOT_TOKEN");
    });
  });
});
