import type { Pinecone } from "@pinecone-database/pinecone";

const MODEL = "multilingual-e5-large";

/**
 * Simple LRU cache for query embeddings.
 * Avoids redundant Pinecone Inference API calls for identical query texts.
 */
class EmbeddingCache {
  private readonly maxSize: number;
  private readonly cache = new Map<string, number[]>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first) entry
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

export class EmbeddingService {
  static readonly BATCH_SIZE = 96;
  static readonly QUERY_CACHE_SIZE = 64;

  private readonly pinecone: Pinecone;
  private readonly queryCache: EmbeddingCache;

  constructor(pinecone: Pinecone) {
    this.pinecone = pinecone;
    this.queryCache = new EmbeddingCache(EmbeddingService.QUERY_CACHE_SIZE);
  }

  async embed(texts: string[], inputType: "passage" | "query"): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // For single-text query embeddings, check cache first
    if (inputType === "query" && texts.length === 1) {
      const cached = this.queryCache.get(texts[0]);
      if (cached) {
        return [cached.slice()];
      }
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += EmbeddingService.BATCH_SIZE) {
      const batch = texts.slice(i, i + EmbeddingService.BATCH_SIZE);
      const response = await this.pinecone.inference.embed({
        model: MODEL,
        inputs: batch,
        parameters: { input_type: inputType, truncate: "END" },
      });

      for (const item of response.data) {
        if (item.vectorType === "dense") {
          results.push(item.values);
        }
      }
    }

    // Cache single-text query embeddings
    if (inputType === "query" && texts.length === 1 && results.length === 1) {
      this.queryCache.set(texts[0], results[0].slice());
    }

    return results;
  }

  /** @internal Clear the query embedding cache. */
  clearCache(): void {
    this.queryCache.clear();
  }

  /** @internal Current number of cached query embeddings. */
  get cacheSize(): number {
    return this.queryCache.size;
  }
}
