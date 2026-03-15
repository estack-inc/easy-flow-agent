import type { ChunkMetadata, MemoryChunk } from "./types.js";

export class TextChunker {
  private readonly chunkSize: number;
  private readonly overlapSize: number;

  constructor(config?: { chunkSize?: number; overlapSize?: number }) {
    this.chunkSize = config?.chunkSize ?? 1000;
    this.overlapSize = config?.overlapSize ?? 100;
  }

  chunk(params: {
    text: string;
    agentId: string;
    sourceFile: string;
    sourceType: ChunkMetadata["sourceType"];
    turnId?: string;
    role?: "user" | "assistant";
    category?: string;
  }): MemoryChunk[] {
    const { text, agentId, sourceFile, sourceType, turnId, role } = params;

    if (text.length === 0) {
      return [];
    }

    const chunks: MemoryChunk[] = [];
    const step = this.chunkSize - this.overlapSize;
    let chunkIndex = 0;

    for (let start = 0; start < text.length; start += step) {
      const end = Math.min(start + this.chunkSize, text.length);
      const chunkText = text.slice(start, end);

      chunks.push({
        id: `${agentId}:${sourceFile}:${chunkIndex}`,
        text: chunkText,
        metadata: {
          agentId,
          sourceFile,
          sourceType,
          chunkIndex,
          createdAt: Date.now(),
          ...(turnId !== undefined && { turnId }),
          ...(role !== undefined && { role }),
          ...(params.category !== undefined && { category: params.category }),
        },
      });

      chunkIndex++;

      if (end >= text.length) {
        break;
      }
    }

    return chunks;
  }
}
