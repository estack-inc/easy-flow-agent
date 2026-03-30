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
      expect(res.setHeader).toHaveBeenCalledWith("Content-Security-Policy", "default-src 'none'");
      expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      expect(res.setHeader).toHaveBeenCalledWith("Content-Length", "1024");
    });

    it("X-Forwarded-For を偽装しても別の IP として Rate Limit が適用される", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const socketIp = "10.0.0.1";

      // 30 回はソケット IP でカウント
      for (let i = 0; i < 30; i++) {
        const req = createMockReq({
          url: `/files/${VALID_UUID}/test.pdf`,
          headers: { "x-forwarded-for": "1.2.3.4" }, // 偽装ヘッダ
          remoteAddress: socketIp,
        });
        const { res } = createMockRes();
        await handler(req, res);
      }

      // 31 回目もソケット IP でカウント → 429
      const req31 = createMockReq({
        url: `/files/${VALID_UUID}/test.pdf`,
        headers: { "x-forwarded-for": "9.9.9.9" }, // 別の偽装 IP
        remoteAddress: socketIp,
      });
      const { res: res31, state: state31 } = createMockRes();
      await handler(req31, res31);

      expect(state31.statusCode).toBe(429);
    });

    it("meta.mimeType が許可外（text/html）→ Content-Type が application/octet-stream に正規化される", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValidMeta({ mimeType: "text/html" }),
      );
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(200);
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");
      expect(res.setHeader).not.toHaveBeenCalledWith("Content-Type", "text/html");
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

    it("TTL 超過 → 410 Gone + HTML に「有効期限が切れました」が含まれ CSP ヘッダが付与される", async () => {
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
      expect(state.headers["content-security-policy"]).toBe("default-src 'none'");
    });

    it("ファイル名セグメントなし（/files/:uuid のみ）→ 400 Bad Request: Missing filename", async () => {
      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(400);
      expect(state.body).toBe("Bad Request: Missing filename");
    });

    it("meta はあるがファイル実体が消えている → 404 かつ logger.warn が呼ばれる", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(404);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("malformed percent-encoding（%GG 等）→ 400", async () => {
      const handler = createHttpHandler(baseConfig, mockLogger);
      // %GG は不正なパーセントエンコードで decodeURIComponent が URIError をスローする
      const req = createMockReq({ url: `/files/${VALID_UUID}/%GGinvalid` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(400);
      expect(state.body).toBe("Bad Request: Invalid URL encoding");
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

    it("同一 IP（remoteAddress）から 31 回アクセス → 31 回目に 429 + Retry-After ヘッダ", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const ip = "192.168.1.1";

      // 30 回は通る（remoteAddress で Rate Limit をカウント）
      for (let i = 0; i < 30; i++) {
        const req = createMockReq({
          url: `/files/${VALID_UUID}/test.pdf`,
          remoteAddress: ip,
        });
        const { res } = createMockRes();
        await handler(req, res);
      }

      // 31 回目は 429
      const req31 = createMockReq({
        url: `/files/${VALID_UUID}/test.pdf`,
        remoteAddress: ip,
      });
      const { res: res31, state: state31 } = createMockRes();
      await handler(req31, res31);

      expect(state31.statusCode).toBe(429);
      expect(state31.headers["retry-after"]).toBeDefined();
    });

    it("fly-client-ip ヘッダが存在する場合はそのヘッダ値で Rate Limit がカウントされる", async () => {
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeValidMeta());
      (fs.promises.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const handler = createHttpHandler(baseConfig, mockLogger);
      const flyIp = "203.0.113.1";

      // fly-client-ip で 30 回カウント（remoteAddress は別 IP）
      for (let i = 0; i < 30; i++) {
        const req = createMockReq({
          url: `/files/${VALID_UUID}/test.pdf`,
          headers: { "fly-client-ip": flyIp },
          remoteAddress: "10.0.0.1", // 別の IP だが fly-client-ip が優先される
        });
        const { res } = createMockRes();
        await handler(req, res);
      }

      // fly-client-ip が同じなら 31 回目は 429（remoteAddress が違っても）
      const req31 = createMockReq({
        url: `/files/${VALID_UUID}/test.pdf`,
        headers: { "fly-client-ip": flyIp },
        remoteAddress: "10.0.0.2", // remoteAddress は変えても同じ fly-client-ip
      });
      const { res: res31, state: state31 } = createMockRes();
      await handler(req31, res31);

      expect(state31.statusCode).toBe(429);
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
    it("410 レスポンスの HTML には config.ttlDays ではなく meta.ttlDays が表示される", async () => {
      // meta.ttlDays=14、config.ttlDays=7 で意図的に乖離させる。
      // HTML には meta.ttlDays=14 が表示されることを検証する。
      const expiredDate = new Date(Date.now() - 15 * 86400000).toISOString();
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValidMeta({ createdAt: expiredDate, ttlDays: 14 }),
      );

      // config.ttlDays は baseConfig の 7 のまま（meta.ttlDays=14 と異なる）
      const handler = createHttpHandler(baseConfig, mockLogger);
      const req = createMockReq({ url: `/files/${VALID_UUID}/test.pdf` });
      const { res, state } = createMockRes();

      await handler(req, res);

      expect(state.statusCode).toBe(410);
      expect(state.body).toContain("14日間"); // meta.ttlDays
      expect(state.body).not.toContain("7日間"); // config.ttlDays は使われない
    });
  });
});
