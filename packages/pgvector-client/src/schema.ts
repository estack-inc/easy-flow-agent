import type { Pool } from "pg";
import pgvector from "pgvector/pg";

const DIMENSIONS = 768;

export async function ensureSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pgvector.registerTypes(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        embedding vector(${DIMENSIONS}),
        metadata JSONB NOT NULL DEFAULT '{}',
        text TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (namespace, id)
      )
    `);

    // HNSW index for cosine similarity — better for small-to-medium datasets
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_embedding
      ON memory_vectors
      USING hnsw (embedding vector_cosine_ops)
    `);

    // B-tree index for namespace filtering (used in query, delete, deleteBySource)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_namespace
      ON memory_vectors (namespace)
    `);
  } finally {
    client.release();
  }
}
