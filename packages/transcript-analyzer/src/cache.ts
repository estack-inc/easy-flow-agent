/**
 * transcript-analyzer cache
 *
 * contracts.md §3.1 / §3.2 準拠：
 * - 保存場所：pgvector 専用 namespace（通常 RAG namespace から隔離）
 *   または file backend（/data/cache/transcript-analyzer/）
 * - 4-key cache：sha256(file_hash + "|" + query_hash + "|" + model + "|" + prompt_version)
 * - TTL：既定 30 日、failure のみ 5 分
 * - 通常 RAG 検索から見えないよう、専用 namespace prefix を強制する
 *
 * 実装：
 * - CacheBackend interface（pgvector / file の差し替え可能）
 * - InMemoryCacheBackend（test / dev 用）
 * - FileCacheBackend（/data/cache/transcript-analyzer/ 配下に JSON 保存）
 *
 * pgvector backend は別 PR（@easy-flow/pgvector-client への接続コード）で追加。
 * Phase 1 では interface を整備し、unit test は InMemory で完結する。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzeTranscriptResponse, CacheEntry, CacheKey } from "./types.js";

/** 通常 RAG から隔離するための専用 namespace */
export const CACHE_NAMESPACE = "transcript-analyzer-cache";

/** SHA256(query normalized) で query_hash を生成 */
export function computeQueryHash(query: string): string {
  const normalized = normalizeQuery(query);
  return sha256Hex(normalized);
}

/** SHA256(file content) で file_hash を生成 */
export function computeFileHash(content: string | Buffer): string {
  return sha256Hex(typeof content === "string" ? content : content.toString("utf8"));
}

/** 4-key cache key を生成（contracts.md §3.1） */
export function buildCacheKey(key: CacheKey): string {
  const concat = `${key.file_hash}|${key.query_hash}|${key.model}|${key.prompt_version}`;
  return sha256Hex(concat);
}

/** Unicode NFKC + trim + 連続空白圧縮 */
export function normalizeQuery(query: string): string {
  if (typeof query !== "string") return "";
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ----------------------------------------------------------------------------
// backend interface
// ----------------------------------------------------------------------------

export interface CacheBackend {
  /** namespace は CACHE_NAMESPACE 固定（通常 RAG と隔離） */
  readonly namespace: string;
  get(key: string, now?: Date): Promise<CacheEntry | null>;
  put(entry: CacheEntry): Promise<void>;
  /** test / cleanup 用 */
  delete(key: string): Promise<void>;
}

// ----------------------------------------------------------------------------
// in-memory backend（test 用 + 標準 fallback）
// ----------------------------------------------------------------------------

export class InMemoryCacheBackend implements CacheBackend {
  readonly namespace = CACHE_NAMESPACE;
  private readonly store = new Map<string, CacheEntry>();

  async get(key: string, now: Date = new Date()): Promise<CacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires_at <= now.getTime()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async put(entry: CacheEntry): Promise<void> {
    this.store.set(entry.key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** test 用 */
  size(): number {
    return this.store.size;
  }
}

// ----------------------------------------------------------------------------
// file backend
// ----------------------------------------------------------------------------

export class FileCacheBackend implements CacheBackend {
  readonly namespace = CACHE_NAMESPACE;
  constructor(private readonly baseDir: string) {
    // baseDir は CACHE_NAMESPACE を強制で含むよう ensure する
    if (!baseDir.includes(CACHE_NAMESPACE)) {
      throw new Error(
        `[transcript-analyzer] FileCacheBackend baseDir must include namespace "${CACHE_NAMESPACE}" to keep RAG isolation`,
      );
    }
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  private filePath(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }

  async get(key: string, now: Date = new Date()): Promise<CacheEntry | null> {
    const fp = this.filePath(key);
    if (!existsSync(fp)) return null;
    try {
      const raw = readFileSync(fp, "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.expires_at <= now.getTime()) {
        try {
          unlinkSync(fp);
        } catch {
          /* ignore */
        }
        return null;
      }
      return entry;
    } catch {
      // 破損 entry は削除して null
      try {
        unlinkSync(fp);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  async put(entry: CacheEntry): Promise<void> {
    writeFileSync(this.filePath(entry.key), JSON.stringify(entry), "utf8");
  }

  async delete(key: string): Promise<void> {
    const fp = this.filePath(key);
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {
        /* ignore */
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 高位 API：CacheStore
// ----------------------------------------------------------------------------

export interface CacheStoreOptions {
  /** 正常応答の TTL（日） */
  ttlDays: number;
  /** failure cache の TTL（分） */
  failureTtlMinutes: number;
}

export class CacheStore {
  constructor(
    private readonly backend: CacheBackend,
    private readonly options: CacheStoreOptions,
  ) {}

  /**
   * cache から response を取得する。
   * 期限切れ entry は null を返す（自動削除は backend 実装に委譲）。
   */
  async get(key: CacheKey, now: Date = new Date()): Promise<AnalyzeTranscriptResponse | null> {
    const k = buildCacheKey(key);
    const entry = await this.backend.get(k, now);
    if (!entry) return null;
    return entry.response;
  }

  /**
   * cache に response を保存する。
   * cache_status: "failure" のみ short TTL（5 分）、それ以外は ttlDays。
   */
  async put(
    key: CacheKey,
    response: AnalyzeTranscriptResponse,
    now: Date = new Date(),
  ): Promise<void> {
    const k = buildCacheKey(key);
    const createdAt = now.getTime();
    const isFailure = response.cache_status === "failure";
    const ttlMs = isFailure
      ? this.options.failureTtlMinutes * 60 * 1000
      : this.options.ttlDays * 24 * 60 * 60 * 1000;
    const entry: CacheEntry = {
      key: k,
      response,
      created_at: createdAt,
      expires_at: createdAt + ttlMs,
    };
    await this.backend.put(entry);
  }

  /** test 用：直接 backend にアクセス */
  getBackend(): CacheBackend {
    return this.backend;
  }
}
