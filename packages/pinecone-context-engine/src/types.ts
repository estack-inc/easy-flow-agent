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
}
