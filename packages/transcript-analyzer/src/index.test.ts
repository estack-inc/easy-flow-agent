/**
 * plugin entry（register / resolveConfig）の単体テスト
 *
 * 検証点：
 * - resolveConfig が contracts.md §9.2 のデフォルト値を反映
 * - register() で registerTool が 3 tool name で呼ばれる
 * - enabled=false で tool 登録をスキップ
 * - sandboxed ctx で null を返す
 * - GEMINI_API_KEY 未設定で warn ログ出力（plugin load は成功）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_NAMESPACE, FileCacheBackend } from "./cache.js";
import { createCacheStore, register, resolveConfig } from "./index.js";

interface MockApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    incrementCounter: ReturnType<typeof vi.fn>;
  };
  registerTool: ReturnType<typeof vi.fn>;
}

function makeApi(config: Record<string, unknown> = {}): MockApi {
  return {
    pluginConfig: config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { incrementCounter: vi.fn() },
    registerTool: vi.fn(),
  };
}

const ENV_BACKUP = process.env.GEMINI_API_KEY;
const CACHE_DIR_BACKUP = process.env.TRANSCRIPT_ANALYZER_CACHE_DIR;
let cacheDir: string | undefined;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "ENV_KEY";
  cacheDir = mkdtempSync(join(tmpdir(), `${CACHE_NAMESPACE}-`));
  process.env.TRANSCRIPT_ANALYZER_CACHE_DIR = cacheDir;
});
afterEach(() => {
  if (ENV_BACKUP === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ENV_BACKUP;
  if (CACHE_DIR_BACKUP === undefined) delete process.env.TRANSCRIPT_ANALYZER_CACHE_DIR;
  else process.env.TRANSCRIPT_ANALYZER_CACHE_DIR = CACHE_DIR_BACKUP;
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  cacheDir = undefined;
});

describe("resolveConfig", () => {
  it("既定値を contracts.md §9.2 に従って返す", () => {
    const cfg = resolveConfig({});
    expect(cfg.transcriptDir).toBe("/data/workspace/zoom_transcribe/");
    expect(cfg.model).toBe("gemini-2.5-flash");
    expect(cfg.fallbackModel).toBe("gemini-1.5-flash");
    expect(cfg.cacheBackend).toBe("file");
    expect(cfg.cacheTtlDays).toBe(30);
    expect(cfg.cacheFailureTtlMinutes).toBe(5);
    expect(cfg.maxAnalyzePerSession).toBe(20);
    expect(cfg.maxAnalyzePerFilePerDay).toBe(50);
    expect(cfg.monthlySpendCapUsd).toBe(50);
    expect(cfg.promptVersion).toBe("v1");
    expect(cfg.geminiTimeoutSec).toBe(60);
    expect(cfg.enabled).toBe(true);
  });

  it("config の上書きが反映される", () => {
    const cfg = resolveConfig({
      model: "gemini-2.5-flash-002",
      cacheBackend: "file",
      cacheTtlDays: 7,
      enabled: false,
    });
    expect(cfg.model).toBe("gemini-2.5-flash-002");
    expect(cfg.cacheBackend).toBe("file");
    expect(cfg.cacheTtlDays).toBe(7);
    expect(cfg.enabled).toBe(false);
  });

  it("不正値（型 mismatch）は default にフォールバック", () => {
    const cfg = resolveConfig({
      cacheTtlDays: -1 as unknown as number,
      monthlySpendCapUsd: "abc" as unknown as number,
      cacheBackend: "redis" as unknown as "file",
    });
    expect(cfg.cacheTtlDays).toBe(30);
    expect(cfg.monthlySpendCapUsd).toBe(50);
    expect(cfg.cacheBackend).toBe("file");
  });

  it("非 Gemini model は default にフォールバック", () => {
    const cfg = resolveConfig({
      model: "gpt-4.1",
      fallbackModel: "gpt-4.1",
    });
    expect(cfg.model).toBe("gemini-2.5-flash");
    expect(cfg.fallbackModel).toBe("gemini-1.5-flash");
  });
});

describe("createCacheStore", () => {
  it("cacheBackend='file' で FileCacheBackend を使う", () => {
    const cfg = resolveConfig({ cacheBackend: "file" });
    const store = createCacheStore(cfg);
    expect(store.getBackend()).toBeInstanceOf(FileCacheBackend);
  });
});

describe("register", () => {
  it("registerTool が 3 tool name で呼ばれる", () => {
    const api = makeApi();
    register(api as never);
    expect(api.registerTool).toHaveBeenCalledOnce();
    const [, options] = api.registerTool.mock.calls[0];
    expect(options.names).toEqual([
      "transcript-analyzer.list_transcripts",
      "transcript-analyzer.search_transcripts",
      "transcript-analyzer.analyze_transcript",
    ]);
    expect(options.optional).toBe(true);
  });

  it("enabled=false なら registerTool 未実行 + warn ログ", () => {
    const api = makeApi({ enabled: false });
    register(api as never);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("起動時に registered ログを出力", () => {
    const api = makeApi();
    register(api as never);
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("registered"));
  });

  it("GEMINI_API_KEY 未設定で warn ログ + plugin load 成功", () => {
    delete process.env.GEMINI_API_KEY;
    const api = makeApi();
    register(api as never);
    expect(api.registerTool).toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_KEY"));
  });

  it("factory: sandboxed ctx は null を返す", () => {
    const api = makeApi();
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    expect(factory({ sandboxed: true })).toBeNull();
  });

  it("factory: 通常 ctx で 3 tool を返す", () => {
    const api = makeApi();
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const tools = factory({});
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(3);
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "transcript-analyzer.list_transcripts",
      "transcript-analyzer.search_transcripts",
      "transcript-analyzer.analyze_transcript",
    ]);
  });

  it("各 tool に parameters schema が存在", () => {
    const api = makeApi();
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const tools = factory({});
    for (const t of tools) {
      expect(t.parameters).toBeDefined();
      expect((t.parameters as { type: string }).type).toBe("object");
    }
  });

  it("list_transcripts tool は execute で JSON content を返す", async () => {
    const api = makeApi({ transcriptDir: "/nonexistent/path/xxx" });
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const tools = factory({});
    const listTool = tools.find(
      (t: { name: string }) => t.name === "transcript-analyzer.list_transcripts",
    );
    const result = await listTool.execute("call-1", {});
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.transcripts).toEqual([]);
  });

  it("search_transcripts tool は execute で empty query を扱える", async () => {
    const api = makeApi({ transcriptDir: "/nonexistent/path/xxx" });
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const tools = factory({});
    const searchTool = tools.find(
      (t: { name: string }) => t.name === "transcript-analyzer.search_transcripts",
    );
    const result = await searchTool.execute("call-1", { query: "" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.chunks).toEqual([]);
    expect(parsed.total_found).toBe(0);
  });

  it("analyze_transcript tool は execute で empty args を failure として返す", async () => {
    const api = makeApi({ transcriptDir: "/nonexistent/path/xxx" });
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const tools = factory({ sessionId: "test-1" });
    const analyzeTool = tools.find(
      (t: { name: string }) => t.name === "transcript-analyzer.analyze_transcript",
    );
    const result = await analyzeTool.execute("call-1", {
      transcript_id: "",
      query: "",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(["failure", "quota_exceeded"]).toContain(parsed.cache_status);
  });

  it("ctx.resolveApiKeyForProvider が factory に渡される", () => {
    const api = makeApi();
    register(api as never);
    const factory = api.registerTool.mock.calls[0][0];
    const resolveApiKeyForProvider = vi.fn(async () => "PROVIDER_KEY");
    const tools = factory({ resolveApiKeyForProvider });
    expect(tools).toHaveLength(3);
    // factory が ctx を読み取って GeminiClient を組んでいる（呼び出し時点では resolve は走らない）
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });
});

describe("npm package metadata", () => {
  it("openclaw.extensions は存在するビルド済み extension を import できる", async () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
      openclaw: { extensions: string[] };
    };

    expect(packageJson.openclaw.extensions).toEqual(["./transcript-analyzer/index.js"]);
    for (const extension of packageJson.openclaw.extensions) {
      const extensionPath = resolve(packageDir, extension);
      expect(existsSync(extensionPath)).toBe(true);

      const mod = (await import(extensionPath)) as {
        default?: unknown;
        register?: unknown;
      };
      expect(mod.default).toEqual(expect.objectContaining({ kind: "plugin" }));
      expect(typeof (mod.default as { register?: unknown }).register).toBe("function");
      expect(typeof mod.register).toBe("function");
    }
  });

  it("ビルド済み transcript-analyzer extension は OpenClaw plugin として register できる", async () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const extensionPath = resolve(packageDir, "transcript-analyzer/index.js");
    const mod = (await import(extensionPath)) as {
      default: { register: (api: unknown) => void };
      register: (api: unknown) => void;
    };
    const api = makeApi();

    expect(mod.register).toBe(mod.default.register);
    mod.default.register(api);

    expect(api.registerTool).toHaveBeenCalledOnce();
    const [, options] = api.registerTool.mock.calls[0];
    expect(options.names).toEqual([
      "transcript-analyzer.list_transcripts",
      "transcript-analyzer.search_transcripts",
      "transcript-analyzer.analyze_transcript",
    ]);
  });
});
