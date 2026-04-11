import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IPineconeClient, MemoryChunk } from "@easy-flow/pinecone-client";

export interface ParsedSection {
  heading: string;
  text: string;
}

export interface AgentsMigrateResult {
  chunks: number;
  totalTokens: number;
  upsertedChunks: number;
  sections: { heading: string; tokens: number }[];
}

/**
 * Estimate token count from text.
 *
 * Based on Claude tokenizer empirical data:
 * - ASCII (U+0000–U+007F): ~4 chars/token → 0.25 tokens/char
 * - Japanese/CJK: ~1–2 tokens/char → 1.5 tokens/char (avg)
 * - Fullwidth/Halfwidth forms: ~1 token/char
 * - Other non-ASCII: ~1 token/char
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7f) {
      tokens += 0.25;
    } else if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      tokens += 1.5;
    } else if (code >= 0xff00 && code <= 0xffef) {
      tokens += 1.0;
    } else {
      tokens += 1.0;
    }
  }
  return Math.ceil(tokens);
}

export function parseMarkdownSections(text: string): ParsedSection[] {
  const lines = text.split("\n");
  const sections: ParsedSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) {
      if (currentHeading || currentLines.length > 0) {
        const body = currentLines.join("\n").trim();
        if (currentHeading || body) {
          sections.push({
            heading: currentHeading,
            text: currentHeading ? `${currentHeading}\n\n${body}`.trim() : body,
          });
        }
      }
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentHeading || currentLines.length > 0) {
    const body = currentLines.join("\n").trim();
    if (currentHeading || body) {
      sections.push({
        heading: currentHeading,
        text: currentHeading ? `${currentHeading}\n\n${body}`.trim() : body,
      });
    }
  }

  return sections;
}

export class AgentsMigrator {
  private readonly client: IPineconeClient;
  private readonly agentId: string;
  private readonly dryRun: boolean;

  constructor(params: {
    pineconeClient: IPineconeClient;
    agentId: string;
    dryRun?: boolean;
  }) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.dryRun = params.dryRun ?? false;
  }

  async migrate(filePath: string): Promise<AgentsMigrateResult> {
    const content = await readFile(filePath, "utf-8");

    if (!content.trim()) {
      return { chunks: 0, totalTokens: 0, upsertedChunks: 0, sections: [] };
    }

    const sections = parseMarkdownSections(content);

    if (sections.length === 0) {
      return { chunks: 0, totalTokens: 0, upsertedChunks: 0, sections: [] };
    }

    const sourceFile = path.basename(filePath);
    const now = Date.now();

    const chunks: MemoryChunk[] = sections.map((section, index) => ({
      id: `${this.agentId}:${sourceFile}:${index}`,
      text: section.text,
      metadata: {
        agentId: this.agentId,
        sourceFile,
        sourceType: "agents_rule" as const,
        chunkIndex: index,
        createdAt: now,
      },
    }));

    const sectionSummaries = sections.map((s) => ({
      heading: s.heading || "(preamble)",
      tokens: estimateTokens(s.text),
    }));

    const totalTokens = sectionSummaries.reduce((sum, s) => sum + s.tokens, 0);

    let upsertedChunks = 0;
    if (!this.dryRun && chunks.length > 0) {
      await this.client.deleteBySource(this.agentId, sourceFile);
      await this.client.upsert(chunks);
      upsertedChunks = chunks.length;
    }

    return {
      chunks: chunks.length,
      totalTokens,
      upsertedChunks,
      sections: sectionSummaries,
    };
  }
}
