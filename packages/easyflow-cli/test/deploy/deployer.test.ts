import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agentfile } from "../../src/agentfile/types.js";
import { DeploymentsLog } from "../../src/deploy/deployments-log.js";
import { Deployer } from "../../src/deploy/deployer.js";
import type { DeployAdapter, DeployOptions, DeployPlan, DeployResult } from "../../src/deploy/types.js";
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

async function createMockConfigLayer(agentfileYaml: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-deployer-test-"));
  try {
    await fs.writeFile(path.join(tmpDir, "agentfile.yaml"), agentfileYaml, "utf-8");

    const chunks: Buffer[] = [];
    const stream = tar.create({ gzip: true, cwd: tmpDir, portable: true }, ["agentfile.yaml"]);
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
  deployCalledWith: { options: DeployOptions; secrets: Record<string, string> } | null = null;

  async deploy(
    _image: import("../../src/store/types.js").ImageData,
    stored: import("../../src/store/types.js").StoredImage,
    _agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployResult> {
    this.deployCalledWith = { options, secrets };
    return {
      app: options.app,
      target: "fly",
      ref: stored.ref,
      digest: stored.digest,
      url: `https://${options.app}.fly.dev`,
      deployedAt: new Date().toISOString(),
      healthCheck: { ok: true, statusCode: 200, latencyMs: 100 },
    };
  }

  async plan(
    stored: import("../../src/store/types.js").StoredImage,
    _agentfile: Agentfile,
    options: DeployOptions,
  ): Promise<DeployPlan> {
    return {
      app: options.app,
      region: options.region ?? "nrt",
      org: options.org ?? "personal",
      createApp: true,
      createVolume: true,
      image: { ref: stored.ref, digest: stored.digest, size: stored.size },
      channels: [],
      tools: [],
      secretKeys: [],
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
    deployer = new Deployer(
      store,
      new Map([["fly", mockAdapter]]),
      deploymentsLog,
    );
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
      layers: new Map([["config.tar.gz", configLayer]]),
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
      layers: new Map([["config.tar.gz", configLayer]]),
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
  });

  it("plan() でアダプターの plan が呼ばれる", async () => {
    const configLayer = await createMockConfigLayer(MINIMAL_AGENTFILE_YAML);
    await store.save("test/agent:1.0", {
      manifest: {},
      config: {},
      layers: new Map([["config.tar.gz", configLayer]]),
    });

    const plan = await deployer.plan({
      ref: "test/agent:1.0",
      target: "fly",
      app: "my-app",
    });

    expect(plan.app).toBe("my-app");
    expect(plan.createApp).toBe(true);
  });
});
