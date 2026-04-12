import type {
  IPineconeClient,
  MemoryChunk,
  QueryParams,
  QueryResult,
} from "@easy-flow/pinecone-client";
import { TaskType } from "@google/generative-ai";
import { Pool } from "pg";
import pgvector from "pgvector/pg";
import { GeminiEmbeddingService } from "./embedding.js";
import { ensureSchema } from "./schema.js";

const UPSERT_BATCH_SIZE = 100;

export class PgVectorClient implements IPineconeClient {
  private readonly pool: Pool;
  private readonly embeddingService: GeminiEmbeddingService;
  private typesRegistered = false;

  constructor(config: { databaseUrl: string; geminiApiKey: string }) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
    this.embeddingService = new GeminiEmbeddingService(config.geminiApiKey);
  }

  private async getClient() {
    const client = await this.pool.connect();
    if (!this.typesRegistered) {
      try {
        await pgvector.registerTypes(client);
        this.typesRegistered = true;
      } catch (e) {
        client.release();
        throw e;
      }
    }
    return client;
  }

  async ensureIndex(): Promise<void> {
    await ensureSchema(this.pool);
  }

  async upsert(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const agentId = chunks[0].metadata.agentId;
    const mixed = chunks.some((c) => c.metadata.agentId !== agentId);
    if (mixed) {
      throw new Error("All chunks must have the same agentId");
    }

    const namespace = `agent:${agentId}`;
    const texts = chunks.map((c) => c.text);
    const embeddings = await this.embeddingService.embed(texts, TaskType.RETRIEVAL_DOCUMENT);

    const client = await this.getClient();
    try {
      for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
        const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
        const batchEmbeddings = embeddings.slice(i, i + UPSERT_BATCH_SIZE);

        const values: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          values.push(
            `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`,
          );
          params.push(
            chunk.id,
            namespace,
            pgvector.toSql(batchEmbeddings[j]),
            JSON.stringify({ ...chunk.metadata, text: chunk.text }),
            chunk.text,
            chunk.metadata.createdAt,
          );
          paramIdx += 6;
        }

        await client.query(
          `INSERT INTO memory_vectors (id, namespace, embedding, metadata, text, created_at)
           VALUES ${values.join(", ")}
           ON CONFLICT (namespace, id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata,
             text = EXCLUDED.text,
             created_at = EXCLUDED.created_at`,
          params,
        );
      }
    } finally {
      client.release();
    }
  }

  async query(params: QueryParams): Promise<QueryResult[]> {
    const { text, agentId, topK = 20, minScore = 0.7, filterCategory } = params;
    const namespace = `agent:${agentId}`;

    const [queryEmbedding] = await this.embeddingService.embed([text], TaskType.RETRIEVAL_QUERY);

    const client = await this.getClient();
    try {
      let sql = `
        SELECT id, metadata, text,
               1 - (embedding <=> $1) AS score
        FROM memory_vectors
        WHERE namespace = $2
      `;
      const sqlParams: unknown[] = [pgvector.toSql(queryEmbedding), namespace];
      let paramIdx = 3;

      if (filterCategory) {
        sql += ` AND metadata->>'category' = $${paramIdx}`;
        sqlParams.push(filterCategory);
        paramIdx++;
      }

      sql += ` ORDER BY embedding <=> $1 LIMIT $${paramIdx}`;
      sqlParams.push(topK);

      const result = await client.query(sql, sqlParams);

      return result.rows
        .filter((row: { score: number }) => row.score >= minScore)
        .map(
          (row: {
            id: string;
            metadata: Record<string, unknown>;
            text: string;
            score: number;
          }) => ({
            chunk: {
              id: row.id,
              text: (row.metadata?.text as string) ?? row.text,
              metadata: {
                agentId: (row.metadata?.agentId as string) ?? agentId,
                sourceFile: (row.metadata?.sourceFile as string) ?? "",
                sourceType:
                  (row.metadata?.sourceType as MemoryChunk["metadata"]["sourceType"]) ??
                  "memory_file",
                chunkIndex: (row.metadata?.chunkIndex as number) ?? 0,
                createdAt: (row.metadata?.createdAt as number) ?? 0,
                turnId: row.metadata?.turnId as string | undefined,
                role: row.metadata?.role as "user" | "assistant" | undefined,
                category: row.metadata?.category as string | undefined,
              },
            },
            score: row.score,
          }),
        );
    } finally {
      client.release();
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const agentId = ids[0].split(":")[0];
    const mixed = ids.some((id) => id.split(":")[0] !== agentId);
    if (mixed) {
      throw new Error("All ids must belong to the same agentId");
    }

    const namespace = `agent:${agentId}`;
    const client = await this.getClient();
    try {
      await client.query("DELETE FROM memory_vectors WHERE namespace = $1 AND id = ANY($2)", [
        namespace,
        ids,
      ]);
    } finally {
      client.release();
    }
  }

  async deleteBySource(agentId: string, sourceFile: string): Promise<void> {
    const namespace = `agent:${agentId}`;
    const escapedAgentId = agentId.replace(/[%_\\]/g, "\\$&");
    const escapedSourceFile = sourceFile.replace(/[%_\\]/g, "\\$&");
    const prefix = `${escapedAgentId}:${escapedSourceFile}:%`;

    const client = await this.getClient();
    try {
      await client.query(
        "DELETE FROM memory_vectors WHERE namespace = $1 AND id LIKE $2 ESCAPE '\\'",
        [namespace, prefix],
      );
    } finally {
      client.release();
    }
  }

  async deleteNamespace(agentId: string): Promise<void> {
    const namespace = `agent:${agentId}`;
    const client = await this.getClient();
    try {
      await client.query("DELETE FROM memory_vectors WHERE namespace = $1", [namespace]);
    } finally {
      client.release();
    }
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}
