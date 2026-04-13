import { GoogleGenerativeAI, type TaskType } from "@google/generative-ai";

const MODEL = "text-embedding-004";
const BATCH_SIZE = 96;

export class GeminiEmbeddingService {
  static readonly DIMENSIONS = 768;

  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async embed(
    texts: string[],
    taskType: TaskType.RETRIEVAL_DOCUMENT | TaskType.RETRIEVAL_QUERY,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const model = this.client.getGenerativeModel({ model: MODEL });
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { role: "user", parts: [{ text }] },
          taskType,
        })),
      });

      for (const item of response.embeddings) {
        results.push(item.values);
      }
    }

    return results;
  }
}
