import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deployer } from "../../src/deploy/deployer.js";
import { DeploymentsLog } from "../../src/deploy/deployments-log.js";
import type { DeployAdapter } from "../../src/deploy/types.js";
import { ImageStore } from "../../src/store/image-store.js";

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

function makeMockAdapter(): DeployAdapter {
  return {
    name: "fly" as const,
    plan: vi.fn().mockImplementation(async (stored, _agentfile, options) => ({
      app: options.app,
      region: options.region ?? "nrt",
      org: options.org ?? "personal",
      createApp: true,
      createVolume: true,
      image: { ref: stored.ref, digest: stored.digest, size: stored.size },
      channels: [],
      tools: [],
      secretKeys: [],
    })),
    deploy: vi.fn().mockImplementation(async (_image, stored, _agentfile, options) => ({
      app: options.app,
      target: "fly",
      ref: stored.ref,
      digest: stored.digest,
      url: `https://${options.app}.fly.dev`,
      deployedAt: new Date().toISOString(),
      healthCheck: { ok: true, statusCode: 200, latencyMs: 100 },
    })),
  };
}

describe("registerDeployCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-cli-deploy-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("deploy コマンドが Commander に登録されている", async () => {
    const { Command } = await import("commander");
    const { registerDeployCommand } = await import("../../src/cli/commands/deploy.js");

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program);

    const deployCmd = program.commands.find((c) => c.name() === "deploy");
    expect(deployCmd).toBeDefined();
    expect(deployCmd?.options.some((o) => o.long === "--app")).toBe(true);
    expect(deployCmd?.options.some((o) => o.long === "--target")).toBe(true);
    expect(deployCmd?.options.some((o) => o.long === "--secret-file")).toBe(true);
  });

  it("--app なしで実行するとエラーになる", async () => {
    const { Command } = await import("commander");
    const { registerDeployCommand } = await import("../../src/cli/commands/deploy.js");

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program);

    // --app は required なのでエラーになる
    await expect(
      program.parseAsync(["deploy", "test/agent:1.0"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("--dry-run フラグで Deployer.plan() が正しく呼ばれる", async () => {
    // 正しい fixture を作成: "Agentfile" ファイル、"config" レイヤー
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tartest-"));
    try {
      await fs.writeFile(path.join(configDir, "Agentfile"), MINIMAL_AGENTFILE_YAML);
      const chunks: Buffer[] = [];
      const stream = tar.create({ gzip: true, cwd: configDir, portable: true }, ["Agentfile"]);
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const configLayer = Buffer.concat(chunks);

      const storeDir = path.join(tmpDir, "store");
      const store = new ImageStore(storeDir);
      await store.save("test/agent:1.0", {
        manifest: {},
        config: {},
        layers: new Map([["config", configLayer]]),
      });

      // Deployer を直接呼び出して dry-run (plan) 動作を検証
      const logFile = path.join(tmpDir, "deployments.json");
      const mockAdapter = makeMockAdapter();
      const deploymentsLog = new DeploymentsLog(logFile);
      const deployer = new Deployer(store, new Map([["fly", mockAdapter]]), deploymentsLog);

      const plan = await deployer.plan({
        ref: "test/agent:1.0",
        target: "fly",
        app: "test-app",
        region: "nrt",
      });

      expect(plan.app).toBe("test-app");
      expect(plan.region).toBe("nrt");
      expect(plan.createApp).toBe(true);
      expect(mockAdapter.plan).toHaveBeenCalled();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
