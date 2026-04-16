/**
 * 任意ドキュメントを pgvector に事前登録する
 *
 * テキスト / Markdown ファイルを読み込み、チャンク分割 → pgvector upsert する。
 * sourceType は "document" を使用し、category でドキュメント種別を区別する。
 * 同一ファイルの再登録時は deleteBySource → upsert で古いチャンクを残さない。
 */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
import { TextChunker } from "@easy-flow/pinecone-client";

export interface IngestDocumentOptions {
  filePath: string;
  agentId: string;
  pgvectorClient: IPineconeClient;
  /** Optional category for filtering (e.g. "manual", "faq", "policy") */
  category?: string;
  /** Custom source file identifier. Defaults to filename. */
  sourceFile?: string;
  dryRun?: boolean;
}

export interface IngestDocumentResult {
  filePath: string;
  sourceFile: string;
  agentId: string;
  totalChunks: number;
  category?: string;
}

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".text"]);

export function isSupportedExtension(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
    );
  }
  return readFile(filePath, "utf-8");
}

export async function ingestDocument(opts: IngestDocumentOptions): Promise<IngestDocumentResult> {
  const { filePath, agentId, pgvectorClient, category, dryRun } = opts;
  const sourceFile = opts.sourceFile ?? `doc:${resolve(filePath)}`;

  console.log(`\n📄 Ingesting: ${filePath}`);
  console.log(`   Agent: ${agentId}`);
  console.log(`   Source: ${sourceFile}`);
  if (category) console.log(`   Category: ${category}`);

  const text = await extractText(filePath);
  console.log(`   Text length: ${text.length} chars`);

  if (text.trim().length === 0) {
    console.log("   ⚠️  Empty file, skipping");
    return { filePath, sourceFile, agentId, totalChunks: 0, category };
  }

  const chunker = new TextChunker();
  const chunks = chunker.chunk({
    text,
    agentId,
    sourceFile,
    sourceType: "document",
    category,
  });

  console.log(`   Chunks: ${chunks.length}`);

  if (dryRun) {
    console.log("   [DRY RUN] Would delete existing + upsert chunks");
  } else {
    await pgvectorClient.deleteBySource(agentId, sourceFile);
    await pgvectorClient.upsert(chunks);
    console.log(`   ✅ Replaced with ${chunks.length} chunks`);
  }

  return { filePath, sourceFile, agentId, totalChunks: chunks.length, category };
}

export async function ingestDocuments(
  opts: Omit<IngestDocumentOptions, "filePath"> & { filePaths: string[] },
): Promise<IngestDocumentResult[]> {
  const { filePaths, agentId, pgvectorClient, category, sourceFile, dryRun } = opts;

  console.log(`\n${"=".repeat(60)}`);
  console.log("ドキュメント事前登録");
  console.log(`${"=".repeat(60)}`);
  console.log(`Agent: ${agentId}`);
  console.log(`Files: ${filePaths.length}`);
  console.log(`Dry run: ${dryRun ?? false}`);

  if (!dryRun) {
    await pgvectorClient.ensureIndex();
  }

  const results: IngestDocumentResult[] = [];

  for (const filePath of filePaths) {
    const result = await ingestDocument({
      filePath,
      agentId,
      pgvectorClient,
      category,
      sourceFile,
      dryRun,
    });
    results.push(result);
  }

  // Summary
  const totalChunks = results.reduce((sum, r) => sum + r.totalChunks, 0);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`完了: ${results.length} files, ${totalChunks} chunks`);
  console.log(`${"=".repeat(60)}`);

  return results;
}
