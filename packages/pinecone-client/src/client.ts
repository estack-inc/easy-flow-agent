import { Pinecone } from "@pinecone-database/pinecone";
import { EmbeddingService } from "./embedding.js";
import { IndexManager } from "./index-manager.js";
import type { IPineconeClient, MemoryChunk, QueryParams, QueryResult } from "./types.js";

const UPSERT_BATCH_SIZE = 100;

export class PineconeClient implements IPineconeClient {
  private readonly pinecone: Pinecone;
  private readonly embeddingService: EmbeddingService;
  private readonly indexManager: IndexManager;

  constructor(config: { apiKey: string; indexName?: string }) {
    this.pinecone = new Pinecone({ apiKey: config.apiKey });
    this.embeddingService = new EmbeddingService(this.pinecone);
    this.indexManager = new IndexManager(
      this.pinecone,
      config.indexName ?? "easy-flow-memory",
    );
  }

  async ensureIndex(): Promise<void> {
    await this.indexManager.ensureIndex();
  }

  async upsert(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const agentId = chunks[0].metadata.agentId;
    const mixed = chunks.some((c) => c.metadata.agentId !== agentId);
    if (mixed) {
      throw new Error("All chunks must have the same agentId");
    }

    const texts = chunks.map((c) => c.text);
    const embeddings = await this.embeddingService.embed(texts, "passage");

    const index = this.indexManager.getIndex();
    const ns = index.namespace(`agent:${agentId}`);

    const records = chunks.map((chunk, i) => ({
      id: chunk.id,
      values: embeddings[i],
      metadata: {
        ...chunk.metadata,
        text: chunk.text,
      },
    }));

    for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
      await ns.upsert({ records: records.slice(i, i + UPSERT_BATCH_SIZE) });
    }
  }

  async query(params: QueryParams): Promise<QueryResult[]> {
    const { text, agentId, topK = 20, minScore = 0.7, filter, filterCategory } = params;

    const [queryEmbedding] = await this.embeddingService.embed([text], "query");

    const index = this.indexManager.getIndex();
    const ns = index.namespace(`agent:${agentId}`);

    const pineconeFilter: Record<string, unknown> = {
      ...filter,
    };
    if (filterCategory) {
      pineconeFilter.category = { $eq: filterCategory };
    }

    const results = await ns.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
      filter: Object.keys(pineconeFilter).length > 0 ? pineconeFilter : undefined,
    });

    return (results.matches ?? [])
      .filter((match) => (match.score ?? 0) >= minScore)
      .map((match) => ({
        chunk: {
          id: match.id,
          text: (match.metadata?.text as string) ?? "",
          metadata: {
            agentId: (match.metadata?.agentId as string) ?? agentId,
            sourceFile: (match.metadata?.sourceFile as string) ?? "",
            sourceType: (match.metadata?.sourceType as MemoryChunk["metadata"]["sourceType"]) ?? "memory_file",
            chunkIndex: (match.metadata?.chunkIndex as number) ?? 0,
            createdAt: (match.metadata?.createdAt as number) ?? 0,
            turnId: match.metadata?.turnId as string | undefined,
            role: match.metadata?.role as "user" | "assistant" | undefined,
          },
        },
        score: match.score ?? 0,
      }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const agentId = ids[0].split(":")[0];
    const mixed = ids.some((id) => id.split(":")[0] !== agentId);
    if (mixed) {
      throw new Error("All ids must belong to the same agentId");
    }

    const index = this.indexManager.getIndex();
    const ns = index.namespace(`agent:${agentId}`);
    await ns.deleteMany({ ids });
  }

  async deleteBySource(agentId: string, sourceFile: string): Promise<void> {
    await this.indexManager.deleteBySource(agentId, sourceFile);
  }

  async deleteNamespace(agentId: string): Promise<void> {
    await this.indexManager.deleteNamespace(agentId);
  }
}
