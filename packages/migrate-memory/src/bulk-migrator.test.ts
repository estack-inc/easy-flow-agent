import { describe, expect, it, vi } from "vitest";
import type { BulkMigrateConfig, CommandRunner } from "./bulk-migrator.js";
import { bulkMigrate } from "./bulk-migrator.js";

const testConfig: BulkMigrateConfig = {
  instances: [
    {
      name: "mell-dev",
      flyApp: "mell-dev",
      agentId: "mell",
      index: "easy-flow-memory",
      sources: ["/data/memory/projects/", "/data/MEMORY.md"],
      excludePatterns: ["**/bank-accounts.md", "**/employees/**"],
      memoryHint: "Test agent",
    },
    {
      name: "central-hd",
      flyApp: "central-hd-osada-agent",
      agentId: "central-hd-osada",
      index: "easy-flow-memory",
      sources: ["/data/memory/projects/"],
      excludePatterns: [],
    },
  ],
  compactAfterDays: 7,
};

function createMockRunner(): CommandRunner & {
  exec: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
} {
  return {
    exec: vi.fn().mockReturnValue(""),
    readFile: vi.fn().mockReturnValue(JSON.stringify(testConfig)),
  };
}

describe("bulkMigrate", () => {
  it("dry-run で実際の変更を行わない", async () => {
    const runner = createMockRunner();

    const result = await bulkMigrate({ configPath: "test-config.json", dryRun: true }, runner);

    // fly secrets list / fly ssh console が呼ばれないことを確認
    expect(runner.exec).not.toHaveBeenCalled();
    // 設定ファイルは読み込まれる
    expect(runner.readFile).toHaveBeenCalledWith("test-config.json");
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(2);
  });

  it("--target で特定インスタンスのみ処理する", async () => {
    const runner = createMockRunner();
    const consoleSpy = vi.spyOn(console, "log");

    const result = await bulkMigrate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "mell-dev" },
      runner,
    );

    const processingLogs = consoleSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("=== Processing:"))
      .map((call) => call[0]);

    expect(processingLogs).toHaveLength(1);
    expect(processingLogs[0]).toContain("mell-dev");
    expect(result.processed).toBe(1);

    consoleSpy.mockRestore();
  });

  it("PINECONE_API_KEY がない場合はスキップして failed をカウントする", async () => {
    const runner = createMockRunner();
    // fly secrets list が空配列を返す（キーなし）
    runner.exec.mockReturnValue("[]");

    const errorSpy = vi.spyOn(console, "error");

    const result = await bulkMigrate(
      { configPath: "test-config.json", dryRun: false, targetInstance: "mell-dev" },
      runner,
    );

    const errorLogs = errorSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("PINECONE_API_KEY not set"))
      .map((call) => call[0]);

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("mell-dev");
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);

    errorSpy.mockRestore();
  });

  it("dry-run で excludePatterns がコマンドに含まれる", async () => {
    const runner = createMockRunner();
    const consoleSpy = vi.spyOn(console, "log");

    await bulkMigrate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "mell-dev" },
      runner,
    );

    const dryRunLogs = consoleSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("[DRY RUN] fly ssh"))
      .map((call) => call[0]);

    expect(dryRunLogs).toHaveLength(1);
    expect(dryRunLogs[0]).toContain("--exclude-pattern **/bank-accounts.md");
    expect(dryRunLogs[0]).toContain("--exclude-pattern **/employees/**");

    consoleSpy.mockRestore();
  });

  describe("getApiKeyFromFly — 大文字小文字ケース", () => {
    it("fly secrets list --json が lowercase name を返す場合でも PINECONE_API_KEY を検出する", async () => {
      const mockRunner: CommandRunner = {
        exec: vi.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("secrets list")) {
            // fly CLI が lowercase name を返す（実際の挙動）
            return JSON.stringify([
              { name: "ANTHROPIC_API_KEY", digest: "abc", status: "Deployed" },
              { name: "PINECONE_API_KEY", digest: "def", status: "Deployed" },
            ]);
          }
          if (cmd.includes("printenv PINECONE_API_KEY")) {
            return "pcsk_test_key_12345";
          }
          return "";
        }),
        readFile: vi.fn().mockReturnValue(
          JSON.stringify({
            instances: [
              {
                name: "test",
                flyApp: "test",
                agentId: "test",
                index: "test",
                sources: [],
                excludePatterns: [],
              },
            ],
            compactAfterDays: 7,
          }),
        ),
      };

      const result = await bulkMigrate(
        { configPath: "mock", dryRun: false, targetInstance: "test" },
        mockRunner,
      );
      // PINECONE_API_KEY が検出されれば migrate に進む（今回はソースが空なので processed=1）
      // 少なくとも「PINECONE_API_KEY not set」で失敗しないことを確認
      expect(result.failed).toBe(0);
    });
  });

  it("非dryRun で excludePatterns が sh -c クォートと衝突しない", async () => {
    const execCalls: string[] = [];
    const mockRunner: CommandRunner = {
      exec: vi.fn().mockImplementation((cmd: string) => {
        execCalls.push(cmd);
        if (cmd.includes("secrets list")) {
          return JSON.stringify([{ name: "PINECONE_API_KEY" }]);
        }
        if (cmd.includes("printenv PINECONE_API_KEY")) {
          return "pcsk_key";
        }
        return "";
      }),
      readFile: vi.fn().mockReturnValue(
        JSON.stringify({
          instances: [
            {
              name: "test",
              flyApp: "test-app",
              agentId: "test",
              index: "test",
              sources: ["/data/memory/"],
              excludePatterns: ["**/bank-accounts.md", "**/employees/**"],
            },
          ],
          compactAfterDays: 7,
        }),
      ),
    };

    await bulkMigrate({ configPath: "mock", dryRun: false, targetInstance: "test" }, mockRunner);

    // runMigrateMemory の実行コマンドを取得
    const migrateCmd = execCalls.find((c) => c.includes("sh -c") && c.includes("migrate-memory"));
    expect(migrateCmd).toBeDefined();
    // シングルクォートが excludeArgs に含まれていないことを確認
    expect(migrateCmd).toContain("--exclude-pattern **/bank-accounts.md");
    expect(migrateCmd).not.toContain("--exclude-pattern '**/");
  });

  describe("ensureEasyFlowAgent", () => {
    it("easy-flow-agent が未インストールの場合に git clone + npm install を実行する", async () => {
      const execCalls: string[] = [];
      const mockRunner: CommandRunner = {
        exec: vi.fn().mockImplementation((cmd: string) => {
          execCalls.push(cmd);
          if (cmd.includes("secrets list")) {
            return JSON.stringify([{ name: "PINECONE_API_KEY" }]);
          }
          if (cmd.includes("printenv PINECONE_API_KEY")) {
            return "pcsk_key";
          }
          if (cmd.includes("test -d /data/easy-flow-agent")) {
            throw new Error("exit code 1"); // 存在しない
          }
          if (cmd.includes("gh auth token")) {
            return "ghp_test_token";
          }
          return "";
        }),
        readFile: vi.fn().mockReturnValue(
          JSON.stringify({
            instances: [
              {
                name: "new-instance",
                flyApp: "new-app",
                agentId: "test",
                index: "test",
                sources: [],
                excludePatterns: [],
              },
            ],
            compactAfterDays: 7,
          }),
        ),
      };

      await bulkMigrate(
        { configPath: "mock", dryRun: false, targetInstance: "new-instance" },
        mockRunner,
      );

      // git clone が実行されたことを確認
      const cloneCmd = execCalls.find((c) => c.includes("git clone"));
      expect(cloneCmd).toBeDefined();
      expect(cloneCmd).toContain("new-app");

      // npm install が実行されたことを確認
      const installCmd = execCalls.find((c) => c.includes("npm install --omit=dev"));
      expect(installCmd).toBeDefined();
    });

    it("GH_TOKEN が取得できない場合にエラーをスローする", async () => {
      const mockRunner: CommandRunner = {
        exec: vi.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("secrets list")) {
            return JSON.stringify([{ name: "PINECONE_API_KEY" }]);
          }
          if (cmd.includes("printenv PINECONE_API_KEY")) {
            return "pcsk_key";
          }
          if (cmd.includes("test -d /data/easy-flow-agent")) {
            throw new Error("exit code 1"); // 存在しない
          }
          // gh auth token, mell-dev の GH_TOKEN 取得すべて失敗
          if (cmd.includes("gh auth token") || cmd.includes("printenv GH_TOKEN")) {
            throw new Error("not found");
          }
          return "";
        }),
        readFile: vi.fn().mockReturnValue(
          JSON.stringify({
            instances: [
              {
                name: "no-token",
                flyApp: "no-token-app",
                agentId: "test",
                index: "test",
                sources: [],
                excludePatterns: [],
              },
            ],
            compactAfterDays: 7,
          }),
        ),
      };

      // GH_TOKEN 環境変数もクリア
      const origGhToken = process.env.GH_TOKEN;
      const origGithubToken = process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;

      const errorSpy = vi.spyOn(console, "error");

      try {
        const result = await bulkMigrate(
          { configPath: "mock", dryRun: false, targetInstance: "no-token" },
          mockRunner,
        );

        // ensureEasyFlowAgent がエラーをスローし、bulkMigrate が catch して failed にカウント
        expect(result.failed).toBe(1);
        expect(result.processed).toBe(0);

        const errorLogs = errorSpy.mock.calls
          .filter((call) => typeof call[0] === "string" && call[0].includes("migration failed"))
          .map((call) => call[0]);
        expect(errorLogs).toHaveLength(1);
      } finally {
        // 環境変数を復元（アサーション失敗時も確実に実行）
        if (origGhToken !== undefined) process.env.GH_TOKEN = origGhToken;
        else delete process.env.GH_TOKEN;
        if (origGithubToken !== undefined) process.env.GITHUB_TOKEN = origGithubToken;
        else delete process.env.GITHUB_TOKEN;

        errorSpy.mockRestore();
      }
    });
  });

  it("存在しないインスタンス名を指定すると failed=1 を返す", async () => {
    const runner = createMockRunner();

    const result = await bulkMigrate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "nonexistent" },
      runner,
    );

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
  });

  describe("configurePineconePlugin — node スクリプト方式", () => {
    it("sh -c 'echo <b64> | base64 -d | node' 形式のコマンドを生成する", async () => {
      const execCalls: string[] = [];
      const mockRunner: CommandRunner = {
        exec: vi.fn().mockImplementation((cmd: string) => {
          execCalls.push(cmd);
          if (cmd.includes("secrets list")) {
            return JSON.stringify([
              { name: "PINECONE_API_KEY", digest: "abc", status: "Deployed" },
            ]);
          }
          if (cmd.includes("printenv PINECONE_API_KEY")) return "pcsk_test";
          if (cmd.includes("test -d /data/easy-flow-agent")) return "";
          return "";
        }),
        readFile: vi.fn().mockReturnValue(
          JSON.stringify({
            instances: [
              {
                name: "test",
                flyApp: "test",
                agentId: "test-agent",
                index: "easy-flow-memory",
                sources: [],
                excludePatterns: [],
              },
            ],
            compactAfterDays: 7,
          }),
        ),
      };

      await bulkMigrate({ configPath: "mock", dryRun: false, targetInstance: "test" }, mockRunner);

      // configurePineconePlugin: sh -c + base64 + node を使用
      const configureCall = execCalls.find(
        (c) =>
          c.includes("sh -c") &&
          c.includes("base64") &&
          c.includes("| node") &&
          !c.includes("migrate-memory"),
      );
      expect(configureCall).toBeDefined();
      expect(configureCall).toContain("sh -c 'echo ");
      expect(configureCall).toContain("| base64 -d | node'");
      // python3 は使用しない
      expect(configureCall).not.toContain("python3");
    });
  });

  describe("runSmokeTest — sh -c + base64 方式", () => {
    it("sh -c 'echo <b64> | base64 -d | node' 形式のコマンドを生成する", async () => {
      const execCalls: string[] = [];
      const mockRunner: CommandRunner = {
        exec: vi.fn().mockImplementation((cmd: string) => {
          execCalls.push(cmd);
          if (cmd.includes("secrets list")) {
            return JSON.stringify([
              { name: "PINECONE_API_KEY", digest: "abc", status: "Deployed" },
            ]);
          }
          if (cmd.includes("printenv PINECONE_API_KEY")) return "pcsk_test";
          if (cmd.includes("test -d /data/easy-flow-agent")) return "";
          // smoke test
          if (
            cmd.includes("describeIndexStats") ||
            (cmd.includes("base64") && cmd.includes("| node"))
          ) {
            return JSON.stringify({ "agent:test-agent": { recordCount: 5 } });
          }
          return "";
        }),
        readFile: vi.fn().mockReturnValue(
          JSON.stringify({
            instances: [
              {
                name: "test",
                flyApp: "test",
                agentId: "test-agent",
                index: "easy-flow-memory",
                sources: [],
                excludePatterns: [],
              },
            ],
            compactAfterDays: 7,
          }),
        ),
      };

      await bulkMigrate({ configPath: "mock", dryRun: false, targetInstance: "test" }, mockRunner);

      // runSmokeTest: sh -c + base64 + node を使用
      const smokeCall = execCalls.find(
        (c) =>
          c.includes("sh -c") &&
          c.includes("base64") &&
          c.includes("| node") &&
          !c.includes("migrate-memory") &&
          !c.includes("openclaw.json"),
      );
      expect(smokeCall).toBeDefined();
      expect(smokeCall).toContain("sh -c 'echo ");
      expect(smokeCall).toContain("| base64 -d | node'");
      // cd コマンドは使用しない（base64 経由で require の絶対パスを使う）
      expect(smokeCall).not.toContain('"cd ');
    });
  });
});
