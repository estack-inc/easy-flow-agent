import { describe, it, expect, vi } from "vitest";
import { bulkMigrate } from "./bulk-migrator.js";
import type { CommandRunner, BulkMigrateConfig } from "./bulk-migrator.js";

const testConfig: BulkMigrateConfig = {
  instances: [
    {
      name: "mell-dev",
      flyApp: "mell-dev",
      agentId: "mell",
      index: "easy-flow-memory",
      sources: ["/data/memory/projects/", "/data/MEMORY.md"],
      excludePatterns: ["**/bank-accounts.md"],
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
  pineconeIndex: "easy-flow-memory",
  compactAfterDays: 7,
};

function createMockRunner(): CommandRunner & { exec: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> } {
  return {
    exec: vi.fn().mockReturnValue(""),
    readFile: vi.fn().mockReturnValue(JSON.stringify(testConfig)),
  };
}

describe("bulkMigrate", () => {
  it("dry-run で実際の変更を行わない", async () => {
    const runner = createMockRunner();

    await bulkMigrate(
      { configPath: "test-config.json", dryRun: true },
      runner,
    );

    // fly secrets list / fly ssh console が呼ばれないことを確認
    expect(runner.exec).not.toHaveBeenCalled();
    // 設定ファイルは読み込まれる
    expect(runner.readFile).toHaveBeenCalledWith("test-config.json");
  });

  it("--target で特定インスタンスのみ処理する", async () => {
    const runner = createMockRunner();
    const consoleSpy = vi.spyOn(console, "log");

    await bulkMigrate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "mell-dev" },
      runner,
    );

    const processingLogs = consoleSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("=== Processing:"))
      .map((call) => call[0]);

    expect(processingLogs).toHaveLength(1);
    expect(processingLogs[0]).toContain("mell-dev");

    consoleSpy.mockRestore();
  });

  it("PINECONE_API_KEY がない場合はスキップする", async () => {
    const runner = createMockRunner();
    // fly secrets list が空配列を返す（キーなし）
    runner.exec.mockReturnValue("[]");

    const errorSpy = vi.spyOn(console, "error");

    await bulkMigrate(
      { configPath: "test-config.json", dryRun: false, targetInstance: "mell-dev" },
      runner,
    );

    const errorLogs = errorSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("PINECONE_API_KEY not set"))
      .map((call) => call[0]);

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("mell-dev");

    errorSpy.mockRestore();
  });
});
