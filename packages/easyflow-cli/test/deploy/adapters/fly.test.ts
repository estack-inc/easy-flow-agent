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
    secretsList: vi.fn().mockResolvedValue("[]"),
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

function makeProviderSecrets(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
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

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        makeProviderSecrets(),
      );

      expect(plan.createApp).toBe(true);
      expect(plan.app).toBe("my-test-app");
      expect(plan.region).toBe("nrt");
    });

    it("アプリが既存の場合 createApp=false を返す", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "GATEWAY_TOKEN" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        makeProviderSecrets(),
      );

      expect(plan.createApp).toBe(false);
      expect(plan.createVolume).toBe(false);
    });

    it("dry-run でも flyctl.apps / flyctl.volumes が呼ばれ正確な plan が返る", async () => {
      const appsFn = vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }]));
      const volumesFn = vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }]));
      const flyctl = makeMockFlyctl({
        apps: appsFn,
        volumes: volumesFn,
        secretsList: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "GATEWAY_TOKEN" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions({ dryRun: true }),
        makeProviderSecrets(),
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
        makeProviderSecrets(),
      );

      expect(plan.createApp).toBe(true);
      expect(plan.createVolume).toBe(true);
    });

    it("既存アプリの plan では Fly secrets を読んで secretKeys に反映する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "GEMINI_API_KEY" }]),
          ),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      const plan = await adapter.plan(
        makeStoredImage(),
        makeAgentfile(),
        makeDeployOptions(),
        makeProviderSecrets(),
      );

      expect(plan.secretKeys).toContain("GATEWAY_TOKEN");
      expect(plan.secretKeys).toContain("GEMINI_API_KEY");
    });

    it("アプリ一覧の取得に失敗した場合は createApp=true にせずエラーを伝播する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockRejectedValue(new Error("fly apps unavailable")),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.plan(
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("fly apps unavailable");
    });

    it("既存アプリのボリューム一覧取得に失敗した場合は createVolume=true にせずエラーを伝播する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockRejectedValue(new Error("fly volumes unavailable")),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.plan(
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("fly volumes unavailable");
    });

    it("既存アプリの secrets 一覧取得に失敗した場合は missing secrets にせずエラーを伝播する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockRejectedValue(new Error("fly secrets unavailable")),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.plan(
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("fly secrets unavailable");
    });
  });

  describe("deploy()", () => {
    it("正常デプロイフロー: 必要なステップが順に実行される", async () => {
      const callOrder: string[] = [];
      const volumesCalls: string[][] = [];
      const deployCalls: unknown[][] = [];
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
          volumesCalls.push(args);
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
        deploy: vi.fn().mockImplementation(async (...args: unknown[]) => {
          deployCalls.push(args);
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
      expect(volumesCalls).toContainEqual([
        "create",
        "data",
        "--region",
        "nrt",
        "--size",
        "1",
        "--app",
        "my-test-app",
        "--yes",
      ]);
      expect(callOrder).toContain("secrets:set");
      expect(callOrder).toContain("deploy");
      expect(deployCalls[0]?.[1]).toEqual(
        expect.arrayContaining([
          "--config",
          expect.stringContaining("fly.toml"),
          "--yes",
          "--local-only",
        ]),
      );
      expect(deployCalls[0]?.[2]).toMatchObject({ timeoutMs: 900_000 });
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

    it("ヘルスチェックは fly ssh の接続メッセージが混ざっても末尾の HTTP status を読む", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi.fn().mockResolvedValue(undefined),
        ssh: vi.fn().mockResolvedValue("Connecting to fdaa:example...\n200"),
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

    it("knowledge namespace は pinecone-memory の namespace と同じ agent:<app> を返す", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue("[]"),
        volumes: vi.fn().mockResolvedValue("[]"),
        deploy: vi.fn().mockResolvedValue(undefined),
        ssh: vi.fn().mockResolvedValue("200"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});
      const stored = makeStoredImage();
      stored.metadata.knowledgeChunks = 3;

      const result = await adapter.deploy(
        { manifest: {}, config: {}, layers: new Map() },
        stored,
        makeAgentfile(),
        makeDeployOptions(),
        { ANTHROPIC_API_KEY: "test" },
      );

      expect(result.knowledge).toEqual({ chunks: 3, namespace: "agent:my-test-app" });
    });

    it("アプリ一覧の取得に失敗した場合はアプリ作成に進まずエラーを伝播する", async () => {
      const appsFn = vi.fn().mockRejectedValue(new Error("fly apps unavailable"));
      const flyctl = makeMockFlyctl({
        apps: appsFn,
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("fly apps unavailable");

      expect(appsFn).toHaveBeenCalledTimes(1);
    });

    it("ボリューム一覧の取得に失敗した場合はボリューム作成に進まずエラーを伝播する", async () => {
      const volumesFn = vi.fn().mockRejectedValue(new Error("fly volumes unavailable"));
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: volumesFn,
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("fly volumes unavailable");

      expect(volumesFn).toHaveBeenCalledWith(["list", "--app", "my-test-app", "--json"]);
      expect(volumesFn).toHaveBeenCalledTimes(1);
    });

    it("既存アプリで追加シークレットが不要な場合は flyctl secrets を呼ばない", async () => {
      const secretsFn = vi.fn().mockResolvedValue(undefined);
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "ANTHROPIC_API_KEY" }]),
          ),
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
        {},
      );

      expect(secretsFn).not.toHaveBeenCalled();
    });

    it("初回デプロイでは GATEWAY_TOKEN を生成して secrets set に含める", async () => {
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
        makeProviderSecrets({}),
      );

      expect(secretsFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          "set",
          expect.stringMatching(/^GATEWAY_TOKEN=/),
          "--app",
          "my-test-app",
          "--stage",
        ]),
      );
    });

    it("既存アプリで GATEWAY_TOKEN が Fly secrets にあれば再生成しない", async () => {
      const secretsFn = vi.fn().mockResolvedValue(undefined);
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "ANTHROPIC_API_KEY" }]),
          ),
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
        {},
      );

      expect(secretsFn).not.toHaveBeenCalled();
    });

    it("既存アプリで GATEWAY_TOKEN が local/Fly のどちらにも無い場合は失敗する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockResolvedValue("[]"),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          makeProviderSecrets(),
        ),
      ).rejects.toThrow("GATEWAY_TOKEN");
    });

    it("必要な provider secret が local/Fly のどちらにも無い場合は失敗する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "GATEWAY_TOKEN" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          makeAgentfile(),
          makeDeployOptions(),
          {},
        ),
      ).rejects.toThrow("ANTHROPIC_API_KEY");
    });

    it("モデルが gemini の場合は GEMINI_API_KEY を要求する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "GATEWAY_TOKEN" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});
      const agentfile = makeAgentfile();
      agentfile.config = { model: { default: "gemini-2.5-flash" } };

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          agentfile,
          makeDeployOptions(),
          {},
        ),
      ).rejects.toThrow("GEMINI_API_KEY");
    });

    it("provider key が config.env にある場合でも deploy を許可しない", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "GATEWAY_TOKEN" }])),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});
      const agentfile = makeAgentfile();
      agentfile.config = { env: { ANTHROPIC_API_KEY: "from-agentfile-env" } };

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          agentfile,
          makeDeployOptions(),
          {},
        ),
      ).rejects.toThrow("ANTHROPIC_API_KEY");
    });

    it("RAG 有効時は PINECONE_API_KEY を要求する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "ANTHROPIC_API_KEY" }]),
          ),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});
      const agentfile = makeAgentfile();
      agentfile.config = { rag: { enabled: true } };

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          agentfile,
          makeDeployOptions(),
          {},
        ),
      ).rejects.toThrow("PINECONE_API_KEY");
    });

    it("Gemini モデルでも lossless-claw 用に ANTHROPIC_API_KEY を要求する", async () => {
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "GEMINI_API_KEY" }]),
          ),
      });
      const adapter = new FlyDeployAdapter(flyctl, () => {});
      const agentfile = makeAgentfile();
      agentfile.config = { model: { default: "gemini-2.5-flash" } };

      await expect(
        adapter.deploy(
          { manifest: {}, config: {}, layers: new Map() },
          makeStoredImage(),
          agentfile,
          makeDeployOptions(),
          {},
        ),
      ).rejects.toThrow("ANTHROPIC_API_KEY");
    });

    it("既存 Fly secrets に GEMINI_API_KEY があれば tools.media を維持した template を生成する", async () => {
      let templateContent: string | undefined;
      const flyctl = makeMockFlyctl({
        apps: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "my-test-app" }])),
        volumes: vi.fn().mockResolvedValue(JSON.stringify([{ Name: "data" }])),
        secretsList: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ Name: "GATEWAY_TOKEN" }, { Name: "GEMINI_API_KEY" }]),
          ),
        deploy: vi
          .fn()
          .mockImplementation(
            async (
              _appName: string,
              _args: string[],
              opts?: { cwd?: string; timeoutMs?: number },
            ) => {
              if (opts?.cwd) {
                templateContent = await fs.readFile(
                  path.join(opts.cwd, "openclaw.json.template"),
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
        makeProviderSecrets(),
      );

      const parsedConfig = JSON.parse(templateContent as string) as {
        tools?: { media?: { enabled: boolean } };
      };
      expect(parsedConfig.tools?.media).toEqual({ enabled: true });
    });

    it("Dockerfile と openclaw.json.template と render スクリプトがビルドコンテキストに生成される", async () => {
      let capturedCwd: string | undefined;
      let dockerfileContent: string | undefined;
      let templateContent: string | undefined;
      let renderScriptContent: string | undefined;

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
                templateContent = await fs.readFile(
                  path.join(capturedCwd, "openclaw.json.template"),
                  "utf-8",
                );
                renderScriptContent = await fs.readFile(
                  path.join(capturedCwd, "render-openclaw-config.js"),
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
        makeProviderSecrets(),
      );

      expect(capturedCwd).toBeDefined();
      // Dockerfile は easy-flow-base を digest pin し、Fly runtime 向けに amd64 を明示する。
      expect(dockerfileContent).toContain(
        "FROM --platform=linux/amd64 ghcr.io/estack-inc/easy-flow-base@sha256:da7f2b41080943c65bbcd1e4448c69a10b80f82a179bd4beba3c298b07a12248",
      );
      expect(dockerfileContent).not.toContain("ghcr.io/openclaw/openclaw:latest");
      expect(dockerfileContent).not.toMatch(/\b(?:CMD|ENTRYPOINT)\b/);
      expect(dockerfileContent).toContain("COPY layers/config/ /app/easyflow/config/");
      expect(dockerfileContent).toContain(
        "COPY openclaw.json.template /app/openclaw.json.template",
      );
      expect(dockerfileContent).toContain(
        "COPY render-openclaw-config.js /app/render-openclaw-config.js",
      );
      // テンプレートファイルが存在し、gateway 設定を含む
      expect(templateContent).toBeDefined();
      const parsedConfig = JSON.parse(templateContent as string) as Record<string, unknown>;
      expect(parsedConfig.gateway).toBeDefined();
      expect((parsedConfig.env as Record<string, unknown>).OPENCLAW_AGENT_ID).toBe("my-test-app");
      expect(
        (parsedConfig.plugins as { entries?: Record<string, { config?: Record<string, unknown> }> })
          .entries?.["pinecone-memory"]?.config?.agentId,
      ).toBe("my-test-app");
      // render スクリプトが存在し、プレースホルダ展開ロジックを含む
      expect(renderScriptContent).toBeDefined();
      expect(renderScriptContent).toContain("PLACEHOLDER_PATTERN");
      expect(renderScriptContent).toContain("JSON.stringify(rendered, null, 2)");
      expect(renderScriptContent).toContain("process.exit(1)");
    });

    it("fly.toml に node render スクリプトを呼ぶ app process が含まれ [build].image が含まれない", async () => {
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
        makeProviderSecrets(),
      );

      expect(flyTomlContent).toBeDefined();
      // app process 起動時に node スクリプトがプレースホルダを展開
      expect(flyTomlContent).toContain("[processes]");
      expect(flyTomlContent).toContain("app = \"sh -lc 'mkdir -p /data && node");
      expect(flyTomlContent).toContain("node /app/render-openclaw-config.js");
      expect(flyTomlContent).toContain("/app/openclaw.json.template");
      expect(flyTomlContent).toContain("/data/openclaw.json");
      expect(flyTomlContent).toContain("exec /entrypoint.sh");
      expect(flyTomlContent).toContain('OPENCLAW_STATE_DIR = "/data"');
      expect(flyTomlContent).toContain('OPENCLAW_NO_RESPAWN = "1"');
      expect(flyTomlContent).toContain('path = "/health"');
      expect(flyTomlContent).toContain('size = "shared-cpu-4x"');
      expect(flyTomlContent).toContain('memory = "8192mb"');
      expect(flyTomlContent).not.toContain("[build]");
      expect(flyTomlContent).not.toContain("release_command");
      expect(flyTomlContent).not.toContain("ghcr.io/openclaw/openclaw:latest");
    });
  });
});
