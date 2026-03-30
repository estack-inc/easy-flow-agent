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

  // UUID v4 形式の有効なテスト用 ID
  const EXPIRED_UUID = "550e8400-e29b-41d4-a716-446655440001";
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440002";
  const NO_META_UUID = "550e8400-e29b-41d4-a716-446655440003";
  const EXPIRED_UUID_2 = "550e8400-e29b-41d4-a716-446655440004";

  it("createdAt が 8 日前 → ディレクトリが削除される", async () => {
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([EXPIRED_UUID]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeMeta(8));

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    expect(fs.promises.rm).toHaveBeenCalledWith(`/data/file-serve/${EXPIRED_UUID}`, {
      recursive: true,
      force: true,
    });
  });

  it("createdAt が 6 日前 → ディレクトリが存在する（削除されない）", async () => {
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([VALID_UUID]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeMeta(6));

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it("meta.json なし → エラーなくスキップ（他のファイルに影響なし）", async () => {
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
      NO_META_UUID,
      EXPIRED_UUID_2,
    ]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("ENOENT")) // NO_META_UUID
      .mockResolvedValueOnce(makeMeta(8)); // EXPIRED_UUID_2

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    // NO_META_UUID はスキップ、EXPIRED_UUID_2 は削除
    expect(fs.promises.rm).toHaveBeenCalledTimes(1);
    expect(fs.promises.rm).toHaveBeenCalledWith(`/data/file-serve/${EXPIRED_UUID_2}`, {
      recursive: true,
      force: true,
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("UUID 形式でないエントリ（.DS_Store 等）はスキップされる", async () => {
    (fs.promises.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
      ".DS_Store",
      EXPIRED_UUID,
    ]);
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeMeta(8));

    const service = createCleanupService(baseConfig, mockLogger);
    await service.start();
    service.stop();

    // .DS_Store はスキップ（readFile は EXPIRED_UUID 分のみ呼ばれる）
    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.rm).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(".DS_Store"));
  });
});
