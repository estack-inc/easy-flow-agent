import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { FlyDeployAdapter } from "../../../src/deploy/adapters/fly.js";
import type { FlyctlRunner } from "../../../src/deploy/adapters/flyctl.js";
import type { DeployOptions } from "../../../src/deploy/types.js";
import type { StoredImage } from "../../../src/store/types.js";

function makeMockFlyctl(
  overrides: Partial<Record<keyof FlyctlRunner, unknown>> = {},
): FlyctlRunner {
  return {
    apps: vi.fn().mockResolvedValue("[]"),
    volumes: vi.fn().mockResolvedValue("[]"),
    secrets: vi.fn().mockResolvedValue(undefined),
    deploy: vi.fn().mockResolvedValue(undefined),
    ssh: vi.fn().mockResolvedValue("200"),
    machines: vi.fn().mockResolvedValue("[]"),
    ...overrides,
  } as unknown as FlyctlRunner;
}

function makeStoredImage(ref = "test/agent:1.0"): StoredImage {
  return {
    ref,
    digest: "sha256:abc123",
    size: 1024,
    createdAt: new Date().toISOString(),
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "Test",
      tools: [],
      channels: [],
    },
  };
}

function makeAgentfile(): Agentfile {
  return {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "Test",
      author: "test",
    },
    identity: { name: "TestAgent", soul: "You are helpful." },
  };
}

function makeDeployOptions(overrides: Partial<DeployOptions> = {}): DeployOptions {
  return {
    ref: "test/agent:1.0",
    target: "fly",
    app: "my-test-app",
    region: "nrt",
    org: "personal",
    ...overrides,
  };
}

describe("FlyDeployAdapter", () => {
  describe("plan()", () => {
    it("アプリが存在しない場合 createApp=true を返す", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(makeStoredImage(), makeAgentfile(), makeDeployOptions());

      expect(plan.createApp).toBe(true);
      expect(plan.app).toBe("my-test-app");
      expect(plan.region).toBe("nrt");
    });

    it("アプリが既存の場合 createApp=false を返す", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(makeStoredImage(), makeAgentfile(), makeDeployOptions());

      expect(plan.createApp).toBe(false);
      expect(plan.createVolume).toBe(false);
    });

    it("dry-run でも flyctl.apps / flyctl.volumes が呼ばれ正確な plan が返る", async () => {
      const appsFn = vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }]));
      const volumesFn = vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }]));
      const flyctl = makeMockFlyctl({
        apps: appsFn,
        volumes: volumesFn,
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions({ dryRun: true }),
      );

      // dry-run でも read-only 確認が実行される
      expect(appsFn).toHaveBeenCalledWith(["list", "--json"]);
      expect(volumesFn).toHaveBeenCalledWith(["list", "--app", "my-test-app", "--json"]);
      // 既存アプリ/ボリュームが認識される
      expect(plan.createApp).toBe(false);
      expect(plan.createVolume).toBe(false);
    });

    it("dry-run でアプリが存在しない場合 createApp=true を正しく返す", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions({ dryRun: true }),
      );

      expect(plan.createApp).toBe(true);
      expect(plan.createVolume).toBe(true);
    });
  });

  describe("deploy()", () => {
    it("正常デプロイフロー: 必要なステップが順に実行される", async () => {
      const callOrder: string[] = [];
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockImplementation(async (args: string[]) => {
          if (args[0] === "list") {
            callOrder.push("apps:list");
            return "[]";
          }
          callOrder.push("apps:create");
          return "";
        }),
        volumes: vi.fn().mockImplementation(async (args: string[]) => {
          if (args[0] === "list") {
            callOrder.push("volumes:list");
            return "[]";
          }
          callOrder.push("volumes:create");
          return "";
        }),
        secrets: vi.fn().mockImplementation(async () => {
          callOrder.push("secrets:set");
        }),
        deploy: vi.fn().mockImplementation(async () => {
          callOrder.push("deploy");
        }),
        ssh: vi.fn().mockResolvedValue("200"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const result = await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        { ANTHROPIC_API_KEY: "test-key" },
      );

      expect(callOrder).toContain("apps:list");
      expect(callOrder).toContain("apps:create");
      expect(callOrder).toContain("volumes:list");
      expect(callOrder).toContain("volumes:create");
      expect(callOrder).toContain("secrets:set");
      expect(callOrder).toContain("deploy");
      expect(result.app).toBe("my-test-app");
      expect(result.target).toBe("fly");
    });

    it("ヘルスチェックが成功: SSH が 200 を返す場合 healthCheck.ok=true", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi.fn().mockResolvedValue(undefined),
        ssh: vi.fn().mockResolvedValue("200"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const result = await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        { ANTHROPIC_API_KEY: "test" },
      );

      expect(result.healthCheck.ok).toBe(true);
      expect(result.healthCheck.statusCode).toBe(200);
    });

    it("シークレットが空の場合は flyctl secrets を呼ばない", async () => {
      const secretsFn = vi.fn().mockResolvedValue(undefined);
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi.fn().mockResolvedValue(undefined),
        ssh: vi.fn().mockResolvedValue("200"),
        secrets: secretsFn,
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        {}, // 空のシークレット
      );

      expect(secretsFn).not.toHaveBeenCalled();
    });

    it("Dockerfile と openclaw.json がビルドコンテキストに生成される", async () => {
      let capturedCwd: string | undefined;
      let dockerfileContent: string | undefined;
      let openclawJsonContent: string | undefined;

      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi
          .fn()
          .mockImplementation(
            async (
              _appName: string,
              _args: string[],
              opts?: { cwd?: string; timeoutMs?: number },
            ) => {
              capturedCwd = opts?.cwd;
              if (capturedCwd) {
                dockerfileContent = await fs.readFile(
                  path.join(capturedCwd, "Dockerfile"),
                  "utf-8",
                );
                openclawJsonContent = await fs.readFile(
                  path.join(capturedCwd, "openclaw.json"),
                  "utf-8",
                );
              }
            },
          ),
        ssh: vi.fn().mockResolvedValue("200"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        {},
      );

      expect(capturedCwd).toBeDefined();
      expect(dockerfileContent).toContain("FROM ghcr.io/openclaw/openclaw:latest");
      expect(dockerfileContent).toContain("COPY layers/config/ /app/easyflow/config/");
      expect(dockerfileContent).toContain("COPY openclaw.json /app/openclaw.json");
      expect(openclawJsonContent).toBeDefined();
      const parsedConfig = JSON.parse(openclawJsonContent as string) as Record<string, unknown>;
      expect(parsedConfig.gateway).toBeDefined();
    });

    it("fly.toml に release_command が含まれ [build].image が含まれない", async () => {
      let flyTomlContent: string | undefined;

      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi
          .fn()
          .mockImplementation(
            async (
              _appName: string,
              _args: string[],
              opts?: { cwd?: string; timeoutMs?: number },
            ) => {
              if (opts?.cwd) {
                flyTomlContent = await fs.readFile(path.join(opts.cwd, "fly.toml"), "utf-8");
              }
            },
          ),
        ssh: vi.fn().mockResolvedValue("200"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        {},
      );

      expect(flyTomlContent).toBeDefined();
      expect(flyTomlContent).toContain("release_command");
      expect(flyTomlContent).toContain("/data/openclaw.json");
      expect(flyTomlContent).not.toContain("[build]");
      expect(flyTomlContent).not.toContain("ghcr.io/openclaw/openclaw:latest");
    });
  });
});
