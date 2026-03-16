import type { Pinecone } from "@pinecone-database/pinecone";

const MODEL = "multilingual-e5-large";

export class EmbeddingService {
  static readonly BATCH_SIZE = 96;

  private readonly pinecone: Pinecone;

  constructor(pinecone: Pinecone) {
    this.pinecone = pinecone;
  }

  async embed(texts: string[], inputType: "passage" | "query"): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
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

    return results;
  }
}
