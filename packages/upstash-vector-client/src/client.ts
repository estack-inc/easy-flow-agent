import type {
  IPineconeClient,
  MemoryChunk,
  QueryParams,
  QueryResult,
} from "@easy-flow/pinecone-client";
import { Index } from "@upstash/vector";

const UPSERT_BATCH_SIZE = 100;
const RANGE_PAGE_SIZE = 100;

export class UpstashVectorClient implements IPineconeClient {
  private readonly index: Index;

  /**
   * @param config.url   Upstash Vector REST URL
   * @param config.token Upstash Vector REST token
   */
  constructor(config: { url: string; token: string }) {
    this.index = new Index({ url: config.url, token: config.token });
  }

  async ensureIndex(): Promise<void> {
    // Upstash indexes are created via console or REST API.
    // Verify connectivity by fetching index info.
    await this.index.info();
  }

  async upsert(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const agentId = chunks[0].metadata.agentId;
    const mixed = chunks.some((c) => c.metadata.agentId !== agentId);
    if (mixed) {
      throw new Error("All chunks must have the same agentId");
    }

    const ns = this.index.namespace(`agent:${agentId}`);

    const records = chunks.map((chunk) => ({
      id: chunk.id,
      data: chunk.text,
      metadata: {
        ...chunk.metadata,
        text: chunk.text,
      },
    }));

    for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
      await ns.upsert(records.slice(i, i + UPSERT_BATCH_SIZE));
    }
  }

  async query(params: QueryParams): Promise<QueryResult[]> {
    const { text, agentId, topK = 20, minScore = 0.7, filterCategory } = params;

    const ns = this.index.namespace(`agent:${agentId}`);

    const filter = filterCategory ? `category = '${filterCategory}'` : undefined;

    const results = await ns.query<Record<string, unknown>>({
      data: text,
      topK,
      includeMetadata: true,
      filter,
    });

    return results
      .filter((match) => match.score >= minScore)
      .map((match) => ({
        chunk: {
          id: String(match.id),
          text: (match.metadata?.text as string) ?? "",
          metadata: {
            agentId: (match.metadata?.agentId as string) ?? agentId,
            sourceFile: (match.metadata?.sourceFile as string) ?? "",
            sourceType:
              (match.metadata?.sourceType as MemoryChunk["metadata"]["sourceType"]) ??
              "memory_file",
            chunkIndex: (match.metadata?.chunkIndex as number) ?? 0,
            createdAt: (match.metadata?.createdAt as number) ?? 0,
            turnId: match.metadata?.turnId as string | undefined,
            role: match.metadata?.role as "user" | "assistant" | undefined,
            category: match.metadata?.category as string | undefined,
          },
        },
        score: match.score,
      }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const agentId = ids[0].split(":")[0];
    const mixed = ids.some((id) => id.split(":")[0] !== agentId);
    if (mixed) {
      throw new Error("All ids must belong to the same agentId");
    }

    const ns = this.index.namespace(`agent:${agentId}`);
    await ns.delete(ids);
  }

  async deleteBySource(agentId: string, sourceFile: string): Promise<void> {
    const ns = this.index.namespace(`agent:${agentId}`);
    const prefix = `${agentId}:${sourceFile}:`;

    // Scan namespace with range and collect matching IDs
    const ids: string[] = [];
    let cursor = "0";

    do {
      const page = await ns.range({
        cursor,
        limit: RANGE_PAGE_SIZE,
        includeMetadata: false,
      });

      for (const vector of page.vectors) {
        if (String(vector.id).startsWith(prefix)) {
          ids.push(String(vector.id));
        }
      }

      cursor = page.nextCursor;
    } while (cursor !== "" && cursor !== "0");

    if (ids.length > 0) {
      await ns.delete(ids);
    }
  }

  async deleteNamespace(agentId: string): Promise<void> {
    const ns = this.index.namespace(`agent:${agentId}`);
    await ns.reset();
  }
}
