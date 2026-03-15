import type { IPineconeClient, QueryResult } from "@easy-flow/pinecone-client";

export interface DeleteResult {
  searchedChunks: number | undefined;
  deletedChunks: number | undefined;
  dryRun: boolean;
}

export interface MemoryDeleterParams {
  pineconeClient: IPineconeClient;
  agentId: string;
  dryRun?: boolean;
}

export class MemoryDeleter {
  private readonly client: IPineconeClient;
  private readonly agentId: string;
  private readonly dryRun: boolean;

  constructor(params: MemoryDeleterParams) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.dryRun = params.dryRun ?? false;
  }

  /**
   * Search by keyword (vector similarity) and delete matching chunks.
   * NOTE: This uses approximate semantic search. Results may include loosely related chunks.
   */
  async deleteByKeyword(keyword: string, topK = 20): Promise<DeleteResult> {
    const results: QueryResult[] = await this.client.query({
      text: keyword,
      agentId: this.agentId,
      topK,
      minScore: 0.7,
    });

    if (results.length === 0) {
      return { searchedChunks: 0, deletedChunks: 0, dryRun: this.dryRun };
    }

    const ids = results.map((r) => r.chunk.id);

    if (!this.dryRun) {
      await this.client.delete(ids);
    }

    return {
      searchedChunks: results.length,
      deletedChunks: this.dryRun ? 0 : ids.length,
      dryRun: this.dryRun,
    };
  }

  /**
   * Delete chunks by sourceFile prefix (exact match on sourceFile).
   */
  async deleteBySource(sourceFile: string): Promise<DeleteResult> {
    if (!this.dryRun) {
      await this.client.deleteBySource(this.agentId, sourceFile);
    }

    return {
      searchedChunks: undefined,
      deletedChunks: this.dryRun ? 0 : undefined,
      dryRun: this.dryRun,
    };
  }

  /**
   * Delete all memory for this agent (namespace deletion).
   */
  async deleteAll(): Promise<DeleteResult> {
    if (!this.dryRun) {
      await this.client.deleteNamespace(this.agentId);
    }

    return {
      searchedChunks: undefined,
      deletedChunks: this.dryRun ? 0 : undefined,
      dryRun: this.dryRun,
    };
  }
}
