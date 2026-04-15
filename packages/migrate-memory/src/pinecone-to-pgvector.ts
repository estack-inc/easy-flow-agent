/**
 * Pinecone → pgvector 会話メモリ移行
 *
 * Pinecone に蓄積された会話メモリ（session_turn）を pgvector に移行する。
 * AGENTS.md ルール（agents_rule, memory_file）は既に migrate-memory agents コマンドで
 * 投入済みのため、会話メモリのみを対象とする。
 *
 * 注意: Pinecone は 1024 次元（Pinecone Integrated Inference）、
 * pgvector は 768 次元（Gemini text-embedding-004）のため、
 * テキストを取得して Gemini で再 embedding する。
 */

import type { IPineconeClient, MemoryChunk } from "@easy-flow/pinecone-client";

const PINECONE_LIST_LIMIT = 100;
const PINECONE_FETCH_BATCH = 100;
const UPSERT_BATCH_SIZE = 50;
const GEMINI_RATE_LIMIT_DELAY_MS = 200;

interface PineconeVectorMetadata {
  agentId: string;
  category?: string;
  chunkIndex: number;
  createdAt: number;
  role?: string;
  sourceFile: string;
  sourceType: string;
  text: string;
  turnId?: string;
}

export interface MigrateOptions {
  pineconeApiKey: string;
  pineconeHost: string;
  pgvectorClient: IPineconeClient;
  namespaces: string[];
  dryRun: boolean;
  sourceTypes?: string[];
}

export interface MigrateResult {
  namespace: string;
  totalPinecone: number;
  skippedByFilter: number;
  skippedNoText: number;
  migrated: number;
  errors: number;
}

export async function pineconeList(
  host: string,
  apiKey: string,
  namespace: string,
  paginationToken?: string,
): Promise<{ ids: string[]; nextToken?: string }> {
  const url = new URL(`https://${host}/vectors/list`);
  url.searchParams.set("namespace", namespace);
  url.searchParams.set("limit", String(PINECONE_LIST_LIMIT));
  if (paginationToken) {
    url.searchParams.set("paginationToken", paginationToken);
  }

  const res = await fetch(url.toString(), {
    headers: { "Api-Key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`Pinecone list failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    vectors?: { id: string }[];
    pagination?: { next?: string };
  };

  return {
    ids: (data.vectors ?? []).map((v) => v.id),
    nextToken: data.pagination?.next,
  };
}

export async function pineconeFetch(
  host: string,
  apiKey: string,
  namespace: string,
  ids: string[],
): Promise<Map<string, PineconeVectorMetadata>> {
  const url = new URL(`https://${host}/vectors/fetch`);
  url.searchParams.set("namespace", namespace);
  for (const id of ids) {
    url.searchParams.append("ids", id);
  }

  const res = await fetch(url.toString(), {
    headers: { "Api-Key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`Pinecone fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    vectors: Record<string, { metadata: PineconeVectorMetadata }>;
  };

  const result = new Map<string, PineconeVectorMetadata>();
  for (const [id, v] of Object.entries(data.vectors ?? {})) {
    if (v.metadata) {
      result.set(id, v.metadata);
    }
  }
  return result;
}

async function migrateNamespace(opts: MigrateOptions, namespace: string): Promise<MigrateResult> {
  const agentId = namespace.replace("agent:", "");
  const result: MigrateResult = {
    namespace,
    totalPinecone: 0,
    skippedByFilter: 0,
    skippedNoText: 0,
    migrated: 0,
    errors: 0,
  };

  const sourceTypeFilter = opts.sourceTypes ? new Set(opts.sourceTypes) : null;

  // Phase 1: List all vector IDs from Pinecone
  console.log(`  📋 Listing vectors in ${namespace}...`);
  const allIds: string[] = [];
  let nextToken: string | undefined;

  do {
    const page = await pineconeList(opts.pineconeHost, opts.pineconeApiKey, namespace, nextToken);
    allIds.push(...page.ids);
    nextToken = page.nextToken;
  } while (nextToken);

  result.totalPinecone = allIds.length;
  console.log(`  📊 Total vectors in Pinecone: ${allIds.length}`);

  if (allIds.length === 0) return result;

  // Phase 2: Fetch metadata in batches and filter conversation memory
  const chunksToMigrate: MemoryChunk[] = [];

  for (let i = 0; i < allIds.length; i += PINECONE_FETCH_BATCH) {
    const batchIds = allIds.slice(i, i + PINECONE_FETCH_BATCH);
    const vectors = await pineconeFetch(
      opts.pineconeHost,
      opts.pineconeApiKey,
      namespace,
      batchIds,
    );

    for (const [id, meta] of vectors) {
      // Filter by sourceType (conversation memory only, unless sourceTypes is null = include all)
      if (sourceTypeFilter && !sourceTypeFilter.has(meta.sourceType)) {
        result.skippedByFilter++;
        continue;
      }

      // Skip vectors without text
      if (!meta.text || meta.text.trim().length === 0) {
        result.skippedNoText++;
        continue;
      }

      // Normalize "conversation" to "session_turn" (canonical sourceType for conversation memory)
      const normalizedSourceType =
        meta.sourceType === "conversation" ? "session_turn" : meta.sourceType;
      const normalizedCategory =
        meta.sourceType === "conversation" ? (meta.category ?? "conversation") : meta.category;

      chunksToMigrate.push({
        id,
        text: meta.text,
        metadata: {
          agentId,
          sourceFile: meta.sourceFile,
          sourceType: normalizedSourceType as MemoryChunk["metadata"]["sourceType"],
          chunkIndex: meta.chunkIndex ?? 0,
          createdAt: meta.createdAt ?? Date.now(),
          turnId: meta.turnId,
          role: meta.role as "user" | "assistant" | undefined,
          category: normalizedCategory,
        },
      });
    }

    if ((i + PINECONE_FETCH_BATCH) % 500 === 0 || i + PINECONE_FETCH_BATCH >= allIds.length) {
      console.log(
        `  📥 Fetched ${Math.min(i + PINECONE_FETCH_BATCH, allIds.length)}/${allIds.length} vectors, ${chunksToMigrate.length} conversation chunks found`,
      );
    }
  }

  console.log(
    `  🔍 Conversation memory: ${chunksToMigrate.length} chunks (skipped ${result.skippedByFilter} non-conversation, ${result.skippedNoText} no-text)`,
  );

  if (chunksToMigrate.length === 0) return result;

  if (opts.dryRun) {
    result.migrated = chunksToMigrate.length;
    console.log(`  [DRY RUN] Would migrate ${chunksToMigrate.length} chunks`);
    return result;
  }

  // Phase 3: Upsert to pgvector in batches (PgVectorClient.upsert re-embeds with Gemini)
  for (let i = 0; i < chunksToMigrate.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunksToMigrate.slice(i, i + UPSERT_BATCH_SIZE);
    try {
      await opts.pgvectorClient.upsert(batch);
      result.migrated += batch.length;

      const progress = Math.min(i + UPSERT_BATCH_SIZE, chunksToMigrate.length);
      console.log(`  ⬆️  Upserted ${progress}/${chunksToMigrate.length} chunks`);

      // Rate limit for Gemini embedding API
      if (i + UPSERT_BATCH_SIZE < chunksToMigrate.length) {
        await new Promise((resolve) => setTimeout(resolve, GEMINI_RATE_LIMIT_DELAY_MS));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Batch upsert failed at offset ${i}: ${msg}`);
      result.errors += batch.length;
    }
  }

  return result;
}

export async function migrateConversationMemory(opts: MigrateOptions): Promise<MigrateResult[]> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Pinecone → pgvector 会話メモリ移行`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Pinecone host: ${opts.pineconeHost}`);
  console.log(`Namespaces: ${opts.namespaces.join(", ")}`);
  console.log(`Dry run: ${opts.dryRun}`);
  console.log();

  // Ensure pgvector schema exists before upserting (skip in dry-run mode)
  if (!opts.dryRun) {
    await opts.pgvectorClient.ensureIndex();
  }

  const results: MigrateResult[] = [];

  for (const ns of opts.namespaces) {
    console.log(`\n--- ${ns} ---`);
    const result = await migrateNamespace(opts, ns);
    results.push(result);
    console.log(
      `  ✅ Done: ${result.migrated} migrated, ${result.skippedByFilter} skipped, ${result.errors} errors`,
    );
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Summary");
  console.log(`${"=".repeat(60)}`);
  console.log(
    `${"Namespace".padEnd(30)} ${"Pinecone".padStart(10)} ${"Migrated".padStart(10)} ${"Skipped".padStart(10)} ${"Errors".padStart(10)}`,
  );
  console.log("-".repeat(70));

  let totalMigrated = 0;
  let totalErrors = 0;

  for (const r of results) {
    console.log(
      `${r.namespace.padEnd(30)} ${String(r.totalPinecone).padStart(10)} ${String(r.migrated).padStart(10)} ${String(r.skippedByFilter + r.skippedNoText).padStart(10)} ${String(r.errors).padStart(10)}`,
    );
    totalMigrated += r.migrated;
    totalErrors += r.errors;
  }

  console.log("-".repeat(70));
  console.log(`Total migrated: ${totalMigrated}, errors: ${totalErrors}`);

  return results;
}
