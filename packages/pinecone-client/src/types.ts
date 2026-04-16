export interface MemoryChunk {
  id: string;
  text: string;
  embedding?: number[];
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  agentId: string;
  sourceFile: string;
  sourceType: "memory_file" | "session_turn" | "workflow_state" | "agents_rule" | "document";
  chunkIndex: number;
  createdAt: number;
  turnId?: string;
  role?: "user" | "assistant";
  /** Optional category for filtering (e.g. "conversation", "memory", "workflow") */
  category?: string;
}

export interface QueryResult {
  chunk: MemoryChunk;
  score: number;
}

export interface IPineconeClient {
  upsert(chunks: MemoryChunk[]): Promise<void>;
  query(params: QueryParams): Promise<QueryResult[]>;
  delete(ids: string[]): Promise<void>;
  deleteBySource(agentId: string, sourceFile: string): Promise<void>;
  deleteNamespace(agentId: string): Promise<void>;
  ensureIndex(): Promise<void>;
}

export interface QueryParams {
  text: string;
  agentId: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  /** If specified, only return chunks with this category */
  filterCategory?: string;
}
