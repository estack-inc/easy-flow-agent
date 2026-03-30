import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

// node:fs をモック
vi.mock("node:fs", () => {
  const mockStream = {
    on: vi.fn().mockReturnThis(),
    pipe: vi.fn(),
  };
  return {
    default: {
      promises: {
        access: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn(),
      },
      constants: { R_OK: 4 },
      createReadStream: vi.fn().mockReturnValue(mockStream),
    },
  };
});

import fs from "node:fs";
import type { FileServeConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http-handler.js";

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

function createMockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    url: opts.url ?? "/files/550e8400-e29b-41d4-a716-446655440000/test.pdf",
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" } as Socket,
  } as unknown as IncomingMessage;
}

type MockState = { statusCode: number | undefined; headers: Record<string, string>; body: string };

function createMockRes(): { res: ServerResponse; state: MockState } {
  const state: MockState = { statusCode: undefined, headers: {}, body: "" };
  const res = {
    writeHead: vi.fn((code: number, headers?: Record<string, string>) => {
      state.statusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          state.headers[k.toLowerCase()] = v;
        }
      }
    }),
    setHeader: vi.fn((name: string, value: string) => {
      state.headers[name.toLowerCase()] = value;
    }),
    end: vi.fn((data?: string) => {
      if (data) state.body = data;
    }),
    headersSent: false,
    destroy: vi.fn(),
  } as unknown as ServerResponse;
  return { res, state };
}

function makeValidMeta(
  overrides?: Partial<{
    createdAt: string;
    ttlDays: number;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }>,
) {
  return JSON.stringify({
    filename: "test.pdf",
    mimeType: "application/pdf",
    createdAt: new Date().toISOString(),
    ttlDays: 7,
    sizeBytes: 1024,
    ...overrides,
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("createHttpHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("正常系", () => {
    it("有効な UUID + TTL 内ファイル → 200、正しい Content-Type と Content-Disposition", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(200);
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent("test.pdf")}"; filename*=UTF-8''${encodeURIComponent("test.pdf")}`,
      );
    });

    it("ストリーミング配信: fs.createReadStream が呼ばれる", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res } = createMockRes();

      await handler(req, res);

      expect(fs.createReadStream).toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("UUID が存在しない → 404", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(404);
    });

    it("TTL 超過 → 410 Gone + HTML に「有効期限が切れました」が含まれる", async () => {
      const expiredDate = new Date(Date.now() - 8 * 86400000).toISOString();
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValidMeta({ createdAt: expiredDate }),
      );

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(410);
      expect(state.body).toContain("有効期限が切れました");
    });

    it("UUID 形式不正 → 400", async () => {
      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: "/files/invalid-uuid/test.pdf" });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(400);
    });

    it("パストラバーサル文字列（../../etc/passwd）→ 400", async () => {
      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({
        url: `/files/${VALID_UUID}/${encodeURIComponent("../../etc/passwd")}`,
      });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(400);
    });

    it("同一 IP から 31 回アクセス → 31 回目に 429 + Retry-After ヘッダ", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const ip = "192.168.1.1";

      // 30 回は通る
      for (let i = 0; i < 30; i++) {
        const req = createMockReq({
          url: `/files/${VALID_UUID}/test.pdf`,
          headers: { "x-forwarded-for": ip },
        });
        const { res } = createMockRes();
        await handler(req, res);
      }

      // 31 回目は 429
      const req31 = createMockReq({
        url: `/files/${VALID_UUID}/test.pdf`,
        headers: { "x-forwarded-for": ip },
      });
      const { res: res31, state: state31 } = createMockRes();
      await handler(req31, res31);

      expect(state31.statusCode).toBe(429);
      expect(state31.headers["retry-after"]).toBeDefined();
    });

    it("GET 以外のメソッド（POST 等）→ 405", async () => {
      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ method: "POST", url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(405);
    });

    it("URL のファイル名が meta.filename と不一致 → 404", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValidMeta({ filename: "test.pdf" }),
      );

      const handler = createHttpHandler(baseConfig, mockLogger);
      // URL に meta.json を指定しても取得できないことを確認
      const req = createMockReq({ url: `/files/${VALID_UUID}/meta.json` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(404);
    });

    it("ストリームエラー発生時 → res.destroy() が呼ばれる", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      let errorHandler: ((err: Error) => void) | undefined;
      const mockStream = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === "error") errorHandler = handler;
          return mockStream;
        }),
        pipe: vi.fn(),
      };
      (fs.createReadStream as ReturnType<typeof vi.fn>).mockReturnValue(mockStream);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res } = createMockRes();

      await handler(req, res);

      // ストリームエラーを発火
      errorHandler?.(new Error("read error"));

      expect(res.destroy).toHaveBeenCalled();
    });
  });

  describe("TTL 動的反映", () => {
    it("ttlDays=14 の設定で 410 レスポンスの HTML に 14 日間と表示される", async () => {
      const expiredDate = new Date(Date.now() - 15 * 86400000).toISOString();
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValidMeta({ createdAt: expiredDate, ttlDays: 14 }),
      );

      const config14 = { ...baseConfig, ttlDays: 14 };
      const handler = createHttpHandler(config14, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(410);
      expect(state.body).toContain("14日間");
    });
  });
});
