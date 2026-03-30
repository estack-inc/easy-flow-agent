import { beforeEach, describe, expect, it, vi } from "vitest";

// node:fs をモック
vi.mock("node:fs", () => ({
  default: {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 1024 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// randomUUID をモック（テストの一意性確保）
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("550e8400-e29b-41d4-a716-446655440000"),
}));

import fs from "node:fs";
import { readMeta, saveFile } from "../src/storage.js";

const STORAGE_DIR = "/data/file-serve";
const BASE_URL = "https://example.fly.dev";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("saveFile / validateSourceFilePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: 全て成功
    (fs.promises.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.promises.copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.promises.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 1024 });
    (fs.promises.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.promises.rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  describe("allowedSourceDir 設定時", () => {
    it("許可ディレクトリ内のパスは通過する", async () => {
      const result = await saveFile({
        sourceFilePath: "/tmp/uploads/report.pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        storageDir: STORAGE_DIR,
        baseUrl: BASE_URL,
        allowedSourceDir: "/tmp/uploads",
      });

      expect(result.uuid).toBe(VALID_UUID);
      expect(result.servedUrl).toContain("/files/");
      expect(result.servedUrl).toContain("report.pdf");
    });

    it("許可ディレクトリ外のパスはエラー", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/tmp/other/file.pdf",
          filename: "file.pdf",
          mimeType: "application/pdf",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
          allowedSourceDir: "/tmp/uploads",
        }),
      ).rejects.toThrow("ソースファイルが許可ディレクトリ外です");
    });

    it("パストラバーサル（/tmp/uploads/../etc/shadow）をブロックする", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/tmp/uploads/../etc/shadow",
          filename: "shadow",
          mimeType: "text/plain",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
          allowedSourceDir: "/tmp/uploads",
        }),
      ).rejects.toThrow("ソースファイルが許可ディレクトリ外です");
    });
  });

  describe("allowedSourceDir 未設定時（BLOCKED_SOURCE_PREFIXES）", () => {
    it("/etc/ のパスをブロックする", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/etc/passwd",
          filename: "passwd",
          mimeType: "text/plain",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).rejects.toThrow("許可されていないソースパス");
    });

    it("/home/ のパスをブロックする（SSH 秘密鍵等の漏洩防止）", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/home/user/.ssh/id_rsa",
          filename: "id_rsa",
          mimeType: "text/plain",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).rejects.toThrow("許可されていないソースパス");
    });

    it("/proc/ のパスをブロックする", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/proc/1/environ",
          filename: "environ",
          mimeType: "text/plain",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).rejects.toThrow("許可されていないソースパス");
    });

    it("/tmp/ のパスは通過する", async () => {
      await expect(
        saveFile({
          sourceFilePath: "/tmp/generated-report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).resolves.toMatchObject({ uuid: VALID_UUID });
    });
  });

  describe("saveFile ロールバック", () => {
    it("copyFile 失敗時に destDir をロールバック削除する", async () => {
      (fs.promises.copyFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      await expect(
        saveFile({
          sourceFilePath: "/tmp/report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).rejects.toThrow();

      expect(fs.promises.rm).toHaveBeenCalledWith(`${STORAGE_DIR}/${VALID_UUID}`, {
        recursive: true,
        force: true,
      });
    });

    it("meta.json 書き込み失敗時に destDir をロールバック削除する", async () => {
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOSPC: no space left on device"),
      );

      await expect(
        saveFile({
          sourceFilePath: "/tmp/report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          storageDir: STORAGE_DIR,
          baseUrl: BASE_URL,
        }),
      ).rejects.toThrow();

      expect(fs.promises.rm).toHaveBeenCalledWith(`${STORAGE_DIR}/${VALID_UUID}`, {
        recursive: true,
        force: true,
      });
    });

    it("正常系：ロールバックは呼ばれない", async () => {
      await saveFile({
        sourceFilePath: "/tmp/report.pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        storageDir: STORAGE_DIR,
        baseUrl: BASE_URL,
      });

      expect(fs.promises.rm).not.toHaveBeenCalled();
    });
  });
});

describe("readMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("有効な meta.json → FileMeta を返す", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        filename: "report.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      }),
    );

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).not.toBeNull();
    expect(meta?.filename).toBe("report.pdf");
    expect(meta?.mimeType).toBe("application/pdf");
    expect(meta?.ttlDays).toBe(7);
  });

  it("ファイルが存在しない → null を返す", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ENOENT: no such file or directory"),
    );

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).toBeNull();
  });

  it("不正な JSON → null を返す", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("invalid json {{{");

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).toBeNull();
  });

  it("ttlDays が 0 以下の meta.json → null を返す（parseMetaSafe バリデーション）", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        filename: "report.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 0,
        sizeBytes: 1024,
      }),
    );

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).toBeNull();
  });

  it("sizeBytes が負数の meta.json → null を返す（parseMetaSafe バリデーション）", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        filename: "report.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: -1,
      }),
    );

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).toBeNull();
  });

  it("mimeType が不正フォーマット（スラッシュなし）の meta.json → null を返す", async () => {
    (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        filename: "report.pdf",
        mimeType: "applicationpdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      }),
    );

    const meta = await readMeta(VALID_UUID, STORAGE_DIR);

    expect(meta).toBeNull();
  });
});
