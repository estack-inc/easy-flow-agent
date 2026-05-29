/**
 * cache の単体テスト
 *
 * - 4-key cache key 生成
 * - file_hash 変更で invalidate
 * - prompt_version 変更で invalidate
 * - model 切替で別 key
 * - TTL（30 日 / 5 分）
 * - failure cache の short TTL
 * - FileCacheBackend が CACHE_NAMESPACE を含まない baseDir で reject
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCacheKey,
  CACHE_NAMESPACE,
  CacheStore,
  computeFileHash,
  computeQueryHash,
  FileCacheBackend,
  InMemoryCacheBackend,
  normalizeQuery,
} from "./cache.js";
import type { AnalyzeTranscriptResponse } from "./types.js";

function makeResponse(answer = "ok"): AnalyzeTranscriptResponse {
  return {
    answer,
    citations: [],
    used_chunks: [],
    redactions: [],
    answer_scope: "explicit",
    confidence: 0.8,
    confidence_reason: "test",
    model: "gemini-2.5-flash",
    cache_status: "miss",
    prompt_version: "v1",
    warnings: [],
    open_questions: [],
  };
}

describe("normalizeQuery", () => {
  it("trim + NFKC + 連続空白圧縮", () => {
    expect(normalizeQuery("  hello   world  ")).toBe("hello world");
    expect(normalizeQuery("\tA  B\n")).toBe("A B");
  });

  it("空文字列・非 string", () => {
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery(undefined as unknown as string)).toBe("");
  });
});

describe("computeQueryHash / computeFileHash", () => {
  it("normalize 後に同じ hash を生成", () => {
    expect(computeQueryHash("hello world")).toBe(computeQueryHash("  hello   world  "));
  });

  it("内容が変われば hash が変わる", () => {
    expect(computeFileHash("abc")).not.toBe(computeFileHash("abd"));
  });
});

describe("buildCacheKey", () => {
  it("4 key の全てが key 生成に寄与", () => {
    const base = {
      file_hash: "f",
      query_hash: "q",
      model: "m",
      prompt_version: "v",
    };
    const k0 = buildCacheKey(base);
    expect(buildCacheKey({ ...base, file_hash: "F" })).not.toBe(k0);
    expect(buildCacheKey({ ...base, query_hash: "Q" })).not.toBe(k0);
    expect(buildCacheKey({ ...base, model: "M" })).not.toBe(k0);
    expect(buildCacheKey({ ...base, prompt_version: "V" })).not.toBe(k0);
  });
});

describe("InMemoryCacheBackend", () => {
  it("CACHE_NAMESPACE を持つ", () => {
    const b = new InMemoryCacheBackend();
    expect(b.namespace).toBe(CACHE_NAMESPACE);
  });

  it("put / get で entry を返す", async () => {
    const b = new InMemoryCacheBackend();
    const entry = {
      key: "k1",
      response: makeResponse(),
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    };
    await b.put(entry);
    expect(await b.get("k1")).toEqual(entry);
  });

  it("expired entry は null を返し自動削除", async () => {
    const b = new InMemoryCacheBackend();
    const now = Date.now();
    await b.put({
      key: "k2",
      response: makeResponse(),
      created_at: now - 10_000,
      expires_at: now - 5_000,
    });
    expect(await b.get("k2", new Date(now))).toBeNull();
    expect(b.size()).toBe(0);
  });

  it("delete で entry を削除", async () => {
    const b = new InMemoryCacheBackend();
    await b.put({ key: "k3", response: makeResponse(), created_at: 1, expires_at: 9e15 });
    await b.delete("k3");
    expect(await b.get("k3")).toBeNull();
  });
});

describe("FileCacheBackend", () => {
  it("CACHE_NAMESPACE を含まない baseDir は reject", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ta-cache-"));
    expect(() => new FileCacheBackend(tmp)).toThrow(/namespace/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("正規 baseDir で put / get できる", async () => {
    const tmp = mkdtempSync(join(tmpdir(), `${CACHE_NAMESPACE}-`));
    const b = new FileCacheBackend(tmp);
    await b.put({
      key: "k1",
      response: makeResponse(),
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const got = await b.get("k1");
    expect(got?.key).toBe("k1");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("expired entry は null を返し file 削除", async () => {
    const tmp = mkdtempSync(join(tmpdir(), `${CACHE_NAMESPACE}-`));
    const b = new FileCacheBackend(tmp);
    const now = Date.now();
    await b.put({
      key: "kx",
      response: makeResponse(),
      created_at: now - 10_000,
      expires_at: now - 5_000,
    });
    expect(await b.get("kx", new Date(now))).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("CacheStore", () => {
  it("成功 response は ttlDays で expire", async () => {
    const b = new InMemoryCacheBackend();
    const s = new CacheStore(b, { ttlDays: 30, failureTtlMinutes: 5 });
    const now = new Date("2026-05-28T00:00:00Z");
    await s.put(
      { file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" },
      makeResponse(),
      now,
    );
    // 29 日後はまだ有効
    const day29 = new Date("2026-06-26T00:00:00Z");
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" }, day29),
    ).not.toBeNull();
    // 31 日後は expire
    const day31 = new Date("2026-06-29T00:00:00Z");
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" }, day31),
    ).toBeNull();
  });

  it("failure cache は failureTtlMinutes で expire", async () => {
    const b = new InMemoryCacheBackend();
    const s = new CacheStore(b, { ttlDays: 30, failureTtlMinutes: 5 });
    const now = new Date("2026-05-28T00:00:00Z");
    const fail = { ...makeResponse(), cache_status: "failure" as const };
    await s.put({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" }, fail, now);
    // 4 分後はまだ有効
    const minute4 = new Date(now.getTime() + 4 * 60 * 1000);
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" }, minute4),
    ).not.toBeNull();
    // 6 分後は expire
    const minute6 = new Date(now.getTime() + 6 * 60 * 1000);
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v" }, minute6),
    ).toBeNull();
  });

  it("file_hash 変更で別 entry", async () => {
    const b = new InMemoryCacheBackend();
    const s = new CacheStore(b, { ttlDays: 30, failureTtlMinutes: 5 });
    await s.put(
      { file_hash: "f1", query_hash: "q", model: "m", prompt_version: "v" },
      makeResponse("v1"),
    );
    expect(
      await s.get({ file_hash: "f2", query_hash: "q", model: "m", prompt_version: "v" }),
    ).toBeNull();
  });

  it("model 変更で別 entry", async () => {
    const b = new InMemoryCacheBackend();
    const s = new CacheStore(b, { ttlDays: 30, failureTtlMinutes: 5 });
    await s.put(
      { file_hash: "f", query_hash: "q", model: "m1", prompt_version: "v" },
      makeResponse(),
    );
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m2", prompt_version: "v" }),
    ).toBeNull();
  });

  it("prompt_version 変更で別 entry", async () => {
    const b = new InMemoryCacheBackend();
    const s = new CacheStore(b, { ttlDays: 30, failureTtlMinutes: 5 });
    await s.put(
      { file_hash: "f", query_hash: "q", model: "m", prompt_version: "v1" },
      makeResponse(),
    );
    expect(
      await s.get({ file_hash: "f", query_hash: "q", model: "m", prompt_version: "v2" }),
    ).toBeNull();
  });
});
