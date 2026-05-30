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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** 通常 RAG から隔離するための専用 namespace */
export const CACHE_NAMESPACE = "transcript-analyzer-cache";
/** SHA256(query normalized) で query_hash を生成 */
export function computeQueryHash(query) {
    const normalized = normalizeQuery(query);
    return sha256Hex(normalized);
}
/** SHA256(file content) で file_hash を生成 */
export function computeFileHash(content) {
    return sha256Hex(typeof content === "string" ? content : content.toString("utf8"));
}
/** 4-key cache key を生成（contracts.md §3.1） */
export function buildCacheKey(key) {
    const concat = `${key.file_hash}|${key.query_hash}|${key.model}|${key.prompt_version}`;
    return sha256Hex(concat);
}
/** Unicode NFKC + trim + 連続空白圧縮 */
export function normalizeQuery(query) {
    if (typeof query !== "string")
        return "";
    return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}
function sha256Hex(s) {
    return createHash("sha256").update(s).digest("hex");
}
// ----------------------------------------------------------------------------
// in-memory backend（test 用 + 標準 fallback）
// ----------------------------------------------------------------------------
export class InMemoryCacheBackend {
    namespace = CACHE_NAMESPACE;
    store = new Map();
    async get(key, now = new Date()) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (entry.expires_at <= now.getTime()) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }
    async put(entry) {
        this.store.set(entry.key, entry);
    }
    async delete(key) {
        this.store.delete(key);
    }
    /** test 用 */
    size() {
        return this.store.size;
    }
}
// ----------------------------------------------------------------------------
// file backend
// ----------------------------------------------------------------------------
export class FileCacheBackend {
    baseDir;
    namespace = CACHE_NAMESPACE;
    constructor(baseDir) {
        this.baseDir = baseDir;
        // baseDir は CACHE_NAMESPACE を強制で含むよう ensure する
        if (!baseDir.includes(CACHE_NAMESPACE)) {
            throw new Error(`[transcript-analyzer] FileCacheBackend baseDir must include namespace "${CACHE_NAMESPACE}" to keep RAG isolation`);
        }
        if (!existsSync(baseDir)) {
            mkdirSync(baseDir, { recursive: true });
        }
    }
    filePath(key) {
        return join(this.baseDir, `${key}.json`);
    }
    async get(key, now = new Date()) {
        const fp = this.filePath(key);
        if (!existsSync(fp))
            return null;
        try {
            const raw = readFileSync(fp, "utf8");
            const entry = JSON.parse(raw);
            if (entry.expires_at <= now.getTime()) {
                try {
                    unlinkSync(fp);
                }
                catch {
                    /* ignore */
                }
                return null;
            }
            return entry;
        }
        catch {
            // 破損 entry は削除して null
            try {
                unlinkSync(fp);
            }
            catch {
                /* ignore */
            }
            return null;
        }
    }
    async put(entry) {
        writeFileSync(this.filePath(entry.key), JSON.stringify(entry), "utf8");
    }
    async delete(key) {
        const fp = this.filePath(key);
        if (existsSync(fp)) {
            try {
                unlinkSync(fp);
            }
            catch {
                /* ignore */
            }
        }
    }
}
export class CacheStore {
    backend;
    options;
    constructor(backend, options) {
        this.backend = backend;
        this.options = options;
    }
    /**
     * cache から response を取得する。
     * 期限切れ entry は null を返す（自動削除は backend 実装に委譲）。
     */
    async get(key, now = new Date()) {
        const k = buildCacheKey(key);
        const entry = await this.backend.get(k, now);
        if (!entry)
            return null;
        return entry.response;
    }
    /**
     * cache に response を保存する。
     * cache_status: "failure" のみ short TTL（5 分）、それ以外は ttlDays。
     */
    async put(key, response, now = new Date()) {
        const k = buildCacheKey(key);
        const createdAt = now.getTime();
        const isFailure = response.cache_status === "failure";
        const ttlMs = isFailure
            ? this.options.failureTtlMinutes * 60 * 1000
            : this.options.ttlDays * 24 * 60 * 60 * 1000;
        const entry = {
            key: k,
            response,
            created_at: createdAt,
            expires_at: createdAt + ttlMs,
        };
        await this.backend.put(entry);
    }
    /** test 用：直接 backend にアクセス */
    getBackend() {
        return this.backend;
    }
}
//# sourceMappingURL=cache.js.map