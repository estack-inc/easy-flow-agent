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
}
