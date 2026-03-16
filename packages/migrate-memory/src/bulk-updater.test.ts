import { describe, expect, it, vi } from "vitest";
import type { BulkMigrateConfig, CommandRunner } from "./bulk-migrator.js";
import { bulkUpdate } from "./bulk-updater.js";

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

describe("bulkUpdate", () => {
  it("--dry-run で runner.exec が呼ばれないこと", async () => {
    const runner = createMockRunner();

    const result = await bulkUpdate({ configPath: "test-config.json", dryRun: true }, runner);

    expect(runner.exec).not.toHaveBeenCalled();
    expect(runner.readFile).toHaveBeenCalledWith("test-config.json");
    expect(result.failed).toBe(0);
    expect(result.updated).toBe(2);
  });

  it("--target で特定インスタンスのみ処理されること", async () => {
    const runner = createMockRunner();
    const consoleSpy = vi.spyOn(console, "log");

    const result = await bulkUpdate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "mell-dev" },
      runner,
    );

    const updatingLogs = consoleSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("=== Updating:"))
      .map((call) => call[0]);

    expect(updatingLogs).toHaveLength(1);
    expect(updatingLogs[0]).toContain("mell-dev");
    expect(result.updated).toBe(1);

    consoleSpy.mockRestore();
  });

  it("インスタンス名が見つからない場合に failed=1 が返ること", async () => {
    const runner = createMockRunner();

    const result = await bulkUpdate(
      { configPath: "test-config.json", dryRun: true, targetInstance: "nonexistent" },
      runner,
    );

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
  });

  it("コマンド失敗時に failed がインクリメントされること", async () => {
    const runner = createMockRunner();
    runner.exec.mockImplementation(() => {
      throw new Error("command failed");
    });

    const errorSpy = vi.spyOn(console, "error");

    const result = await bulkUpdate(
      { configPath: "test-config.json", dryRun: false, targetInstance: "mell-dev" },
      runner,
    );

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);

    const errorLogs = errorSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("update failed"))
      .map((call) => call[0]);
    expect(errorLogs).toHaveLength(1);

    errorSpy.mockRestore();
  });
});
