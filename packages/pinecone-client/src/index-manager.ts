import type { Index, Pinecone } from "@pinecone-database/pinecone";

const INDEX_DIMENSION = 1024;
const INDEX_METRIC = "cosine";

export class IndexManager {
  private readonly pinecone: Pinecone;
  private readonly indexName: string;
  private indexCache: Index | null = null;

  constructor(pinecone: Pinecone, indexName: string) {
    this.pinecone = pinecone;
    this.indexName = indexName;
  }

  async ensureIndex(): Promise<void> {
    const list = await this.pinecone.listIndexes();
    const exists = list.indexes?.some((idx) => idx.name === this.indexName);

    if (!exists) {
      await this.pinecone.createIndex({
        name: this.indexName,
        dimension: INDEX_DIMENSION,
        metric: INDEX_METRIC,
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1",
          },
        },
      });
    }
  }

  getIndex(): Index {
    if (!this.indexCache) {
      this.indexCache = this.pinecone.index(this.indexName);
    }
    return this.indexCache;
  }

  async deleteBySource(agentId: string, sourceFile: string): Promise<void> {
    const index = this.getIndex();
    const ns = index.namespace(`agent:${agentId}`);

    // Pinecone SDK v7: list vectors by prefix, then delete
    // ID format: "{agentId}:{sourceFile}:{chunkIndex}"
    const prefix = `${agentId}:${sourceFile}:`;
    const listed = await ns.listPaginated({ prefix });
    const ids: string[] = [];

    if (listed.vectors) {
      for (const v of listed.vectors) {
        if (v.id) {
          ids.push(v.id);
        }
      }
    }

    // Continue pagination
    let nextToken = listed.pagination?.next;
    while (nextToken) {
      const page = await ns.listPaginated({ prefix, paginationToken: nextToken });
      if (page.vectors) {
        for (const v of page.vectors) {
          if (v.id) {
            ids.push(v.id);
          }
        }
      }
      nextToken = page.pagination?.next;
    }

    if (ids.length > 0) {
      await ns.deleteMany(ids);
    }
  }

  async deleteNamespace(agentId: string): Promise<void> {
    const index = this.getIndex();
    const ns = index.namespace(`agent:${agentId}`);
    await ns.deleteAll();
  }
}
