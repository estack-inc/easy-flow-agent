/**
 * 任意ドキュメントを pgvector に事前登録する
 *
 * テキスト / Markdown / Office / PDF / URL / Google Docs を読み込み、
 * チャンク分割 → pgvector upsert する。
 * sourceType は "document" を使用し、category でドキュメント種別を区別する。
 * 同一ファイルの再登録時は deleteBySource → upsert で古いチャンクを残さない。
 */

import { resolve } from "node:path";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
import { TextChunker } from "@easy-flow/pinecone-client";
import { checkTextForSecrets } from "./preflight.js";
import { extractText, isUrl } from "./text-extractor.js";

export { extractText, isSupportedInput as isSupportedExtension } from "./text-extractor.js";

export interface IngestDocumentOptions {
  /** File path or URL */
  filePath: string;
  agentId: string;
  pgvectorClient: IPineconeClient;
  /** Optional category for filtering (e.g. "manual", "faq", "policy") */
  category?: string;
  /** Custom source file identifier. Defaults to absolute path or URL. */
  sourceFile?: string;
  dryRun?: boolean;
  /** Skip secret detection preflight check */
  force?: boolean;
}

export interface IngestDocumentResult {
  filePath: string;
  sourceFile: string;
  agentId: string;
  totalChunks: number;
  category?: string;
}

function defaultSourceFile(input: string): string {
  if (isUrl(input)) return `doc:${input}`;
  return `doc:${resolve(input)}`;
}

export async function ingestDocument(opts: IngestDocumentOptions): Promise<IngestDocumentResult> {
  const { filePath, agentId, pgvectorClient, category, dryRun, force } = opts;
  const sourceFile = opts.sourceFile ?? defaultSourceFile(filePath);

  console.log(`\n📄 Ingesting: ${filePath}`);
  console.log(`   Agent: ${agentId}`);
  console.log(`   Source: ${sourceFile}`);
  if (category) console.log(`   Category: ${category}`);

  const text = await extractText(filePath);
  console.log(`   Text length: ${text.length} chars`);

  // Preflight: detect secrets in extracted text
  if (!force) {
    const secrets = checkTextForSecrets(text);
    if (secrets.length > 0) {
      throw new Error(
        `Secret detected in ${filePath}: ${secrets.join(", ")}. Use --force to skip this check.`,
      );
    }
  }

  if (text.trim().length === 0) {
    console.log("   ⚠️  Empty content");
    if (!dryRun) {
      await pgvectorClient.deleteBySource(agentId, sourceFile);
      console.log("   🗑️  Deleted existing chunks for this source");
    }
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
    // Safe replace using staging sourceFile:
    // 1. Upsert new chunks with a staging sourceFile (embedding + DB write)
    // 2. Delete old chunks (original sourceFile) — only after step 1 succeeds
    // 3. Delete staging chunks (cleanup)
    // 4. Upsert final chunks with real sourceFile
    //
    // If step 1 fails → no data loss (old chunks untouched, no staging residue)
    // If step 2/3/4 fails → staging chunks exist as readable backup
    const stagingSourceFile = `${sourceFile}:staging:${Date.now()}`;
    const stagingChunks = chunks.map((c) => ({
      ...c,
      metadata: { ...c.metadata, sourceFile: stagingSourceFile },
    }));

    // Step 1: Validate embedding generation + DB write with staging name
    try {
      await pgvectorClient.upsert(stagingChunks);
    } catch (err) {
      throw new Error(
        `Upsert failed for ${filePath}, existing data preserved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 2: Delete old production chunks (safe — staging backup exists)
    await pgvectorClient.deleteBySource(agentId, sourceFile);

    // Step 3-4: Promote staging → production
    await pgvectorClient.upsert(chunks);
    await pgvectorClient.deleteBySource(agentId, stagingSourceFile);

    console.log(`   ✅ Replaced with ${chunks.length} chunks`);
  }

  return { filePath, sourceFile, agentId, totalChunks: chunks.length, category };
}

export interface IngestDocumentsResult {
  results: IngestDocumentResult[];
  errors: { filePath: string; error: Error }[];
}

export async function ingestDocuments(
  opts: Omit<IngestDocumentOptions, "filePath" | "sourceFile"> & { filePaths: string[] },
): Promise<IngestDocumentsResult> {
  const { filePaths, agentId, pgvectorClient, category, dryRun, force } = opts;

  console.log(`\n${"=".repeat(60)}`);
  console.log("ドキュメント事前登録");
  console.log(`${"=".repeat(60)}`);
  console.log(`Agent: ${agentId}`);
  console.log(`Sources: ${filePaths.length}`);
  console.log(`Dry run: ${dryRun ?? false}`);

  if (!dryRun) {
    await pgvectorClient.ensureIndex();
  }

  const results: IngestDocumentResult[] = [];
  const errors: { filePath: string; error: Error }[] = [];

  for (const filePath of filePaths) {
    try {
      const result = await ingestDocument({
        filePath,
        agentId,
        pgvectorClient,
        category,
        dryRun,
        force,
      });
      results.push(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`   ❌ Failed: ${filePath} — ${error.message}`);
      errors.push({ filePath, error });
    }
  }

  // Summary
  const totalChunks = results.reduce((sum, r) => sum + r.totalChunks, 0);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`完了: ${results.length} 成功, ${errors.length} 失敗, ${totalChunks} chunks`);
  console.log(`${"=".repeat(60)}`);

  return { results, errors };
}
