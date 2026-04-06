import type { ClassificationDetail, ClassificationReason } from "./classifier.js";

export type TurnRecord = {
  reason: ClassificationReason;
  timestamp: number;
};

export type SessionContext = {
  recentTurns: TurnRecord[];
};

type StoreEntry = {
  recentTurns: TurnRecord[];
  lastUpdated: number;
};

type SessionStoreConfig = {
  stickyWindowSize: number;
  sessionTtlMs: number;
  maxSessions: number;
};

/**
 * セッション単位の分類履歴をインメモリで管理するストア。
 *
 * - キー: sessionKey（例: "line:user123", "slack:C0123456"）
 * - プロセス再起動でリセット（意図的。再起動後は default から再開）
 * - TTL 超過エントリは get() 時に遅延削除
 * - maxSessions 超過時に最古エントリを削除
 */
export class SessionStore {
  private readonly store = new Map<string, StoreEntry>();
  private readonly windowSize: number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(config: SessionStoreConfig) {
    this.windowSize = config.stickyWindowSize;
    this.ttlMs = config.sessionTtlMs;
    this.maxSessions = config.maxSessions;
  }

  /** セッションの分類履歴を取得。TTL 超過時は空を返す。 */
  get(sessionKey: string): SessionContext {
    const entry = this.store.get(sessionKey);
    if (!entry) {
      return { recentTurns: [] };
    }
    if (Date.now() - entry.lastUpdated > this.ttlMs) {
      this.store.delete(sessionKey);
      return { recentTurns: [] };
    }
    return { recentTurns: [...entry.recentTurns] };
  }

  /** 分類結果を記録。windowSize を超えた古いターンは切り捨て。 */
  record(sessionKey: string, detail: ClassificationDetail): void {
    const ctx = this.get(sessionKey);
    ctx.recentTurns.push({
      reason: detail.reason,
      timestamp: Date.now(),
    });
    // windowSize を超えた古いターンを切り捨て
    if (ctx.recentTurns.length > this.windowSize) {
      ctx.recentTurns = ctx.recentTurns.slice(-this.windowSize);
    }
    // maxSessions 超過時に最古エントリを削除
    if (!this.store.has(sessionKey) && this.store.size >= this.maxSessions) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(sessionKey, {
      recentTurns: ctx.recentTurns,
      lastUpdated: Date.now(),
    });
  }

  /** 現在の保持セッション数（テスト用） */
  get size(): number {
    return this.store.size;
  }
}
