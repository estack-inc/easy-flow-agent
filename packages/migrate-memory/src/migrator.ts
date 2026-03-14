import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TextChunker } from "@easy-flow/pinecone-client";
import type { IPineconeClient } from "@easy-flow/pinecone-client";

export interface MigrateResult {
  processedFiles: number;
  totalChunks: number;
  upsertedChunks: number;
  skippedFiles: string[];
  errors: { file: string; error: string }[];
}

export class Migrator {
  private readonly client: IPineconeClient;
  private readonly agentId: string;
  private readonly dryRun: boolean;
  private readonly chunker: TextChunker;

  constructor(params: {
    pineconeClient: IPineconeClient;
    agentId: string;
    dryRun?: boolean;
  }) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.dryRun = params.dryRun ?? false;
    this.chunker = new TextChunker();
  }

  async migrate(sources: string[]): Promise<MigrateResult> {
    const result: MigrateResult = {
      processedFiles: 0,
      totalChunks: 0,
      upsertedChunks: 0,
      skippedFiles: [],
      errors: [],
    };

    const files = await this.collectFiles(sources, result.skippedFiles);

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        if (!content.trim()) {
          result.skippedFiles.push(file);
          continue;
        }

        const chunks = this.chunker.chunk({
          text: content,
          agentId: this.agentId,
          sourceFile: file,
          sourceType: "memory_file",
        });

        result.totalChunks += chunks.length;

        if (!this.dryRun && chunks.length > 0) {
          await this.client.upsert(chunks);
          result.upsertedChunks += chunks.length;
        }

        result.processedFiles++;
      } catch (err) {
        result.errors.push({
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  private async collectFiles(
    sources: string[],
    skippedFiles: string[],
  ): Promise<string[]> {
    const files: string[] = [];

    for (const source of sources) {
      try {
        const s = await stat(source);
        if (s.isDirectory()) {
          await this.scanDirectory(source, files);
        } else if (source.endsWith(".md")) {
          files.push(source);
        }
      } catch {
        skippedFiles.push(source);
      }
    }

    return files;
  }

  private async scanDirectory(dir: string, files: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, files);
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
}
