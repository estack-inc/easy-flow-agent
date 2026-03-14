import type { Pinecone } from "@pinecone-database/pinecone";

const MODEL = "multilingual-e5-large";
const BATCH_SIZE = 96;

export class EmbeddingService {
  static readonly BATCH_SIZE = BATCH_SIZE;

  private readonly pinecone: Pinecone;

  constructor(pinecone: Pinecone) {
    this.pinecone = pinecone;
  }

  async embed(
    texts: string[],
    inputType: "passage" | "query",
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await this.pinecone.inference.embed(MODEL, batch, {
        inputType,
      });

      for (const item of response) {
        results.push(item.values as number[]);
      }
    }

    return results;
  }
}
