import type { IPineconeClient } from "@easy-flow/pinecone-client";
import type { ContextEngine } from "openclaw/plugin-sdk";

export type { IPineconeClient } from "@easy-flow/pinecone-client";

export interface PineconeContextEngineParams {
  pineconeClient: IPineconeClient;
  agentId: string;
  tokenBudget?: number;
  ingestRoles?: ("user" | "assistant")[];
  compactAfterDays?: number;
  fallbackAdapter?: ContextEngine;
  /**
   * Messages containing any of these patterns (case-insensitive) will be skipped during ingest.
   * Defaults to DEFAULT_SKIP_PATTERNS if not specified.
   */
  skipPatterns?: string[];
  /** Default category for ingested session turns. Default: "conversation" */
  defaultCategory?: string;
  /** Hint text appended to thin queries to improve Pinecone recall (e.g. MEMORY.md summary) */
  memoryHint?: string;
  /** Token threshold below which a query is considered "thin". Default: 20 */
  minQueryTokens?: number;
  /** Maximum tokens for query text sent to Embedding API. 0 = unlimited. Default: 1024 */
  maxQueryTokens?: number;

  // --- RAG mode params ---
  /** RAG モード有効化。Default: false (env: RAG_ENABLED) */
  ragEnabled?: boolean;
  /** AGENTS-CORE.md の絶対パス (env: RAG_AGENTS_CORE_PATH) */
  agentsCorePath?: string;
  /** AGENTS-CORE.md と動的チャンクを合わせた総トークン予算。Default: 2000 (env: RAG_TOKEN_BUDGET) */
  ragTokenBudget?: number;
  /** 最低類似度スコア。Default: 0.75 (env: RAG_MIN_SCORE) */
  ragMinScore?: number;
  /** 検索結果数。Default: 10 (env: RAG_TOP_K) */
  ragTopK?: number;
}
