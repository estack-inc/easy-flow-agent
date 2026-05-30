/**
 * transcript-analyzer cache
 *
 * contracts.md §3.1 / §3.2 準拠：
 * - 保存場所：file backend（/data/cache/transcript-analyzer-cache/）
 * - 4-key cache：sha256(file_hash + "|" + query_hash + "|" + model + "|" + prompt_version)
 * - TTL：既定 30 日、failure のみ 5 分
 * - 通常 RAG 検索から見えないよう、専用 namespace prefix を強制する
 *
 * 実装：
 * - CacheBackend interface（将来の pgvector backend / file の差し替え可能）
 * - InMemoryCacheBackend（test / dev 用）
 * - FileCacheBackend（/data/cache/transcript-analyzer-cache/ 配下に JSON 保存）
 *
 * pgvector backend は別 PR（@easy-flow/pgvector-client への接続コード）で追加。
 * Phase 1 では interface を整備し、unit test は InMemory で完結する。
 */
import type { AnalyzeTranscriptResponse, CacheEntry, CacheKey } from "./types.js";
/** 通常 RAG から隔離するための専用 namespace */
export declare const CACHE_NAMESPACE = "transcript-analyzer-cache";
/** SHA256(query normalized) で query_hash を生成 */
export declare function computeQueryHash(query: string): string;
/** SHA256(file content) で file_hash を生成 */
export declare function computeFileHash(content: string | Buffer): string;
/** 4-key cache key を生成（contracts.md §3.1） */
export declare function buildCacheKey(key: CacheKey): string;
/** Unicode NFKC + trim + 連続空白圧縮 */
export declare function normalizeQuery(query: string): string;
export interface CacheBackend {
    /** namespace は CACHE_NAMESPACE 固定（通常 RAG と隔離） */
    readonly namespace: string;
    get(key: string, now?: Date): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    /** test / cleanup 用 */
    delete(key: string): Promise<void>;
}
export declare class InMemoryCacheBackend implements CacheBackend {
    readonly namespace = "transcript-analyzer-cache";
    private readonly store;
    get(key: string, now?: Date): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    delete(key: string): Promise<void>;
    /** test 用 */
    size(): number;
}
export declare class FileCacheBackend implements CacheBackend {
    private readonly baseDir;
    readonly namespace = "transcript-analyzer-cache";
    constructor(baseDir: string);
    private filePath;
    get(key: string, now?: Date): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    delete(key: string): Promise<void>;
}
export interface CacheStoreOptions {
    /** 正常応答の TTL（日） */
    ttlDays: number;
    /** failure cache の TTL（分） */
    failureTtlMinutes: number;
}
export declare class CacheStore {
    private readonly backend;
    private readonly options;
    constructor(backend: CacheBackend, options: CacheStoreOptions);
    /**
     * cache から response を取得する。
     * 期限切れ entry は null を返す（自動削除は backend 実装に委譲）。
     */
    get(key: CacheKey, now?: Date): Promise<AnalyzeTranscriptResponse | null>;
    /**
     * cache に response を保存する。
     * cache_status: "failure" のみ short TTL（5 分）、それ以外は ttlDays。
     */
    put(key: CacheKey, response: AnalyzeTranscriptResponse, now?: Date): Promise<void>;
    /** test 用：直接 backend にアクセス */
    getBackend(): CacheBackend;
}
//# sourceMappingURL=cache.d.ts.map