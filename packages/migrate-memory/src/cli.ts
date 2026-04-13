#!/usr/bin/env node

import { parseArgs } from "node:util";
import { PgVectorClient } from "@easy-flow/pgvector-client";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
import { PineconeClient } from "@easy-flow/pinecone-client";
import { bulkMigrate } from "./bulk-migrator.js";
import { bulkUpdate } from "./bulk-updater.js";
import { MemoryDeleter } from "./deleter.js";
import { AgentsMigrator } from "./migrate-agents.js";
import { Migrator } from "./migrator.js";
import { validateExcludePatterns } from "./preflight.js";

type Backend = "pinecone" | "pgvector";

function createClient(backend: Backend, dryRun: boolean): IPineconeClient {
  if (dryRun) return noopClient();

  if (backend !== "pinecone" && backend !== "pgvector") {
    console.error(`Error: Invalid --backend value "${backend}". Must be "pinecone" or "pgvector"`);
    process.exit(1);
  }

  if (backend === "pgvector") {
    const databaseUrl = process.env.PGVECTOR_DATABASE_URL;
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!databaseUrl) {
      console.error(
        "Error: PGVECTOR_DATABASE_URL environment variable is required for pgvector backend",
      );
      process.exit(1);
    }
    if (!geminiApiKey) {
      console.error("Error: GEMINI_API_KEY environment variable is required for pgvector backend");
      process.exit(1);
    }
    return new PgVectorClient({ databaseUrl, geminiApiKey });
  }

  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    console.error("Error: PINECONE_API_KEY environment variable is required for pinecone backend");
    process.exit(1);
  }
  return new PineconeClient({ apiKey });
}

function printUsage(): void {
  console.log(`Usage: easy-flow <command> [options]

Commands:
  migrate-memory    Migrate markdown files to vector DB
  agents            Migrate AGENTS.md to vector DB (section-based chunking)
  memory-delete     Delete memory from vector DB
  bulk-migrate      Bulk migrate all EasyFlow instances
  bulk-update       Bulk update easy-flow-agent on all instances

Global Options:
  --backend <pinecone|pgvector>  Vector DB backend (default: pinecone)

Environment Variables:
  PINECONE_API_KEY         Required for pinecone backend
  PGVECTOR_DATABASE_URL    Required for pgvector backend
  GEMINI_API_KEY           Required for pgvector backend

Run 'easy-flow <command> --help' for command-specific options.`);
}

function printMigrateUsage(): void {
  console.log(`Usage: easy-flow migrate-memory [options]

Options:
  --agent-id <id>            Agent ID (required)
  --source <path>            Source file or directory (repeatable)
  --exclude-pattern <glob>   Exclude files matching glob pattern (repeatable)
  --backend <backend>        Vector DB: pinecone (default) or pgvector
  --dry-run                  Preview without writing
  --force                    Skip pre-flight security checks (NOT RECOMMENDED)
  --help                     Show this help message`);
}

function printDeleteUsage(): void {
  console.log(`Usage: easy-flow memory-delete [options]

Options:
  --agent-id <id>     Agent ID (required)
  --keyword <text>    Search by keyword and delete matching chunks (semantic search)
  --source <file>     Delete chunks by exact sourceFile match
  --all               Delete all memory for this agent (DANGEROUS)
  --backend <backend> Vector DB: pinecone (default) or pgvector
  --dry-run           Preview without deleting
  --help              Show this help message

WARNING: --keyword uses semantic similarity search. Results may include loosely related chunks.
         Always use --dry-run first to preview what will be deleted.`);
}

function noopClient() {
  return {
    upsert: async () => {},
    query: async () => [] as never[],
    delete: async () => {},
    deleteBySource: async () => {},
    deleteNamespace: async () => {},
    ensureIndex: async () => {},
  };
}

async function runMigrate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "agent-id": { type: "string" },
      source: { type: "string", multiple: true },
      "exclude-pattern": { type: "string", multiple: true },
      backend: { type: "string", default: "pinecone" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printMigrateUsage();
    process.exit(0);
  }

  const agentId = values["agent-id"] as string | undefined;
  const sources = (values.source as string[] | undefined) ?? [];
  const excludePatterns = (values["exclude-pattern"] as string[] | undefined) ?? [];
  const backend = values.backend as Backend;
  const dryRun = values["dry-run"] as boolean;
  const force = values.force as boolean;

  if (!agentId) {
    console.error("Error: --agent-id is required");
    process.exit(1);
  }
  if (sources.length === 0) {
    console.error("Error: at least one --source is required");
    process.exit(1);
  }

  // excludePatterns の **/ 検証
  for (const w of validateExcludePatterns(excludePatterns)) {
    console.warn(`[PREFLIGHT WARN] ${w}`);
  }

  const client = createClient(backend, dryRun);
  const migrator = new Migrator({
    pineconeClient: client,
    agentId,
    dryRun,
    force,
    excludePatterns,
  });

  console.log(`${dryRun ? "[DRY RUN] " : ""}Migrating memory for agent: ${agentId}`);
  console.log(`Sources: ${sources.join(", ")}\n`);

  const result = await migrator.migrate(sources);

  console.log("=== Migration Result ===");
  console.log(`Processed files: ${result.processedFiles}`);
  console.log(`Total chunks: ${result.totalChunks}`);
  console.log(`Upserted chunks: ${result.upsertedChunks}`);

  if (result.skippedFiles.length > 0) {
    console.log(`Skipped files: ${result.skippedFiles.join(", ")}`);
  }
  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors) {
      console.log(`  ${err.file}: ${err.error}`);
    }
    process.exit(1);
  }
}

function printAgentsUsage(): void {
  console.log(`Usage: easy-flow agents [options]

Options:
  --file <path>       AGENTS.md file path (required)
  --agent-id <id>     Agent ID (required)
  --backend <backend> Vector DB: pinecone (default) or pgvector
  --dry-run           Preview chunking without writing
  --help              Show this help message`);
}

async function runAgents(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: "string" },
      "agent-id": { type: "string" },
      backend: { type: "string", default: "pinecone" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printAgentsUsage();
    process.exit(0);
  }

  const filePath = values.file as string | undefined;
  const agentId = values["agent-id"] as string | undefined;
  const backend = values.backend as Backend;
  const dryRun = values["dry-run"] as boolean;

  if (!filePath) {
    console.error("Error: --file is required");
    process.exit(1);
  }
  if (!agentId) {
    console.error("Error: --agent-id is required");
    process.exit(1);
  }

  const client = createClient(backend, dryRun);
  const migrator = new AgentsMigrator({ pineconeClient: client, agentId, dryRun });

  const namespace = `agent:${agentId}`;

  if (dryRun) {
    console.log(`📄 Parsing: ${filePath}`);
    console.log(`   Agent ID: ${agentId}`);
    console.log(`   Namespace: ${namespace}\n`);

    const result = await migrator.migrate(filePath);

    console.log("   Chunks:");
    for (let i = 0; i < result.sections.length; i++) {
      const s = result.sections[i];
      console.log(`   [${i + 1}] ${s.heading} (${s.tokens} tokens)`);
    }

    console.log(
      `\n   Total: ${result.chunks} chunks, ~${result.totalTokens.toLocaleString()} tokens`,
    );
    console.log(`   (dry-run: no data written to ${backend})`);
  } else {
    console.log(`📄 Migrating: ${filePath} → ${backend}`);
    console.log(`   Agent ID: ${agentId}`);
    console.log(`   Namespace: ${namespace}\n`);

    const start = Date.now();
    const result = await migrator.migrate(filePath);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const avgTokens = result.chunks > 0 ? Math.round(result.totalTokens / result.chunks) : 0;
    console.log(`   Chunking... done (${result.chunks} chunks, avg ${avgTokens} tokens)`);
    console.log(`   Upserting... done (${result.upsertedChunks}/${result.chunks})`);

    console.log(`\n✅ Migration complete`);
    console.log(`   Chunks: ${result.chunks}`);
    console.log(`   Total tokens: ~${result.totalTokens.toLocaleString()}`);
    console.log(`   Time: ${elapsed}s`);
  }
}

async function runDelete(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "agent-id": { type: "string" },
      keyword: { type: "string" },
      source: { type: "string" },
      all: { type: "boolean", default: false },
      backend: { type: "string", default: "pinecone" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printDeleteUsage();
    process.exit(0);
  }

  const agentId = values["agent-id"] as string | undefined;
  const keyword = values.keyword as string | undefined;
  const source = values.source as string | undefined;
  const deleteAll = values.all as boolean;
  const backend = values.backend as Backend;
  const dryRun = values["dry-run"] as boolean;

  if (!agentId) {
    console.error("Error: --agent-id is required");
    process.exit(1);
  }

  const hasTarget = keyword || source || deleteAll;
  if (!hasTarget) {
    console.error("Error: specify one of --keyword, --source, or --all");
    printDeleteUsage();
    process.exit(1);
  }

  const client = createClient(backend, dryRun);
  const deleter = new MemoryDeleter({ pineconeClient: client, agentId, dryRun });

  console.log(`${dryRun ? "[DRY RUN] " : ""}Deleting memory for agent: ${agentId}`);

  let result: Awaited<ReturnType<MemoryDeleter["deleteByKeyword"]>> | undefined;

  if (keyword) {
    console.log(`Warning: Keyword search uses semantic similarity — review results carefully.`);
    console.log(`Searching for: "${keyword}"\n`);
    result = await deleter.deleteByKeyword(keyword);
    console.log(`Found ${result.searchedChunks} similar chunk(s).`);
  } else if (source) {
    console.log(`Deleting chunks with sourceFile: "${source}"\n`);
    result = await deleter.deleteBySource(source);
  } else if (deleteAll) {
    if (!dryRun) {
      console.log(`Warning: This will delete ALL memory for agent "${agentId}".`);
      console.log(`Proceeding in 3 seconds... (Ctrl+C to cancel)`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    result = await deleter.deleteAll();
  }

  if (result) {
    console.log(dryRun ? "=== DRY RUN (no changes made) ===" : "=== Delete Result ===");
    if (result.searchedChunks != null) {
      console.log(`Chunks found: ${result.searchedChunks}`);
    }
    if (!dryRun) {
      console.log(
        `Chunks deleted: ${result.deletedChunks != null ? result.deletedChunks : "done"}`,
      );
    }
  }
}

function printBulkMigrateUsage(): void {
  console.log(`Usage: easy-flow bulk-migrate [options]

Options:
  --config=<path>     Config file path (default: ./easy-flow-instances.json)
  --target=<name>     Process only the specified instance
  --dry-run           Preview without making changes
  --help              Show this help message`);
}

async function runBulkMigrate(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    printBulkMigrateUsage();
    process.exit(0);
  }

  const configPath =
    args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./easy-flow-instances.json";
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => a.startsWith("--target="))?.split("=")[1];

  console.log(`Bulk migrate: config=${configPath}, dryRun=${dryRun}, target=${target ?? "all"}`);
  const result = await bulkMigrate({ configPath, dryRun, targetInstance: target });
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

function printBulkUpdateUsage(): void {
  console.log(`Usage: easy-flow bulk-update [options]

Options:
  --config=<path>     Config file path (default: ./easy-flow-instances.json)
  --target=<name>     Process only the specified instance
  --dry-run           Preview without making changes
  --help              Show this help message`);
}

async function runBulkUpdate(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    printBulkUpdateUsage();
    process.exit(0);
  }

  const configPath =
    args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./easy-flow-instances.json";
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => a.startsWith("--target="))?.split("=")[1];

  console.log(`Bulk update: config=${configPath}, dryRun=${dryRun}, target=${target ?? "all"}`);
  const result = await bulkUpdate({ configPath, dryRun, targetInstance: target });
  console.log(`\n=== Summary: ${result.updated} updated, ${result.failed} failed ===`);
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "migrate-memory") {
    await runMigrate(process.argv.slice(3));
  } else if (subcommand === "agents") {
    await runAgents(process.argv.slice(3));
  } else if (subcommand === "memory-delete") {
    await runDelete(process.argv.slice(3));
  } else if (subcommand === "bulk-migrate") {
    await runBulkMigrate(process.argv.slice(3));
  } else if (subcommand === "bulk-update") {
    await runBulkUpdate(process.argv.slice(3));
  } else {
    console.error(`Unknown command: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
