import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileServeConfig } from "../src/config.js";

// node:fs をモック
vi.mock("node:fs", () => ({
  default: {
    promises: {
      readdir: vi.fn(),
      readFile: vi.fn(),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import fs from "node:fs";
import { createCleanupService } from "../src/cleanup-service.js";

const baseConfig: FileServeConfig = {
  storageDir: "/data/file-serve",
  baseUrl: "https://example.fly.dev",
  ttlDays: 7,
  rateLimit: { windowMs: 60000, maxRequests: 30 },
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeMeta(daysAgo: number, ttlDays = 7): string {
  const createdAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return JSON.stringify({
    filename: "test.pdf",
    mimeType: "application/pdf",
    createdAt,
    ttlDays,
    sizeBytes: 1024,
  });
}

describe("createCleanupService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createdAt が 8 日前 → ディレクトリが削除される", async () => {
    const uuid = "expired-uuid-001";
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([uuid]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeMeta(8));

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    expect(fs.promises.rm).toHaveBeenCalledWith(`/data/file-serve/${uuid}`, {
      recursive: true,
      force: true,
    });
  });

  it("createdAt が 6 日前 → ディレクトリが存在する（削除されない）", async () => {
    const uuid = "valid-uuid-001";
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([uuid]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeMeta(6));

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it("meta.json なし → エラーなくスキップ（他のファイルに影響なし）", async () => {
    const noMetaUuid = "no-meta-uuid";
    const expiredUuid = "expired-uuid-002";
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([noMetaUuid, expiredUuid]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("ENOENT")) // no-meta-uuid
      .mockResolvedValueOnce(makeMeta(8)); // expired-uuid-002

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    // no-meta-uuid はスキップ、expired-uuid-002 は削除
    expect(fs.promises.rm).toHaveBeenCalledTimes(1);
    expect(fs.promises.rm).toHaveBeenCalledWith(`/data/file-serve/${expiredUuid}`, {
      recursive: true,
      force: true,
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
