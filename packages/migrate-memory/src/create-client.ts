import { PgVectorClient } from "@easy-flow/pgvector-client";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
import { PineconeClient } from "@easy-flow/pinecone-client";

export type Backend = "pinecone" | "pgvector";

function noopClient(): IPineconeClient {
  return {
    upsert: async () => {},
    query: async () => [] as never[],
    delete: async () => {},
    deleteBySource: async () => {},
    deleteNamespace: async () => {},
    ensureIndex: async () => {},
  };
}

export function createClient(backend: Backend, dryRun: boolean): IPineconeClient {
  if (dryRun) return noopClient();

  // parseArgs returns string; cast to validate at runtime against unexpected values
  const backendStr = backend as string;
  if (backendStr !== "pinecone" && backendStr !== "pgvector") {
    console.error(
      `Error: Invalid --backend value "${backendStr}". Must be "pinecone" or "pgvector"`,
    );
    process.exit(1);
  }

  if (backend === "pgvector") {
    const databaseUrl = process.env.PGVECTOR_DATABASE_URL;
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!databaseUrl) {
      console.error(
        "Error: PGVECTOR_DATABASE_URL environment variable is required for pgvector backend",
      );
      process.exit(1);
    }
    if (!geminiApiKey) {
      console.error("Error: GEMINI_API_KEY environment variable is required for pgvector backend");
      process.exit(1);
    }
    return new PgVectorClient({ databaseUrl, geminiApiKey });
  }

  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    console.error("Error: PINECONE_API_KEY environment variable is required for pinecone backend");
    process.exit(1);
  }
  return new PineconeClient({ apiKey });
}
