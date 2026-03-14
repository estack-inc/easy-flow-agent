export interface MemoryChunk {
  id: string;
  text: string;
  embedding?: number[];
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  agentId: string;
  sourceFile: string;
  sourceType: "memory_file" | "session_turn" | "workflow_state";
  chunkIndex: number;
  createdAt: number;
  turnId?: string;
  role?: "user" | "assistant";
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
}
