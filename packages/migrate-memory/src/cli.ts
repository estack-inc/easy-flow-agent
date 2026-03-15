#!/usr/bin/env node

import { parseArgs } from "node:util";
import { PineconeClient } from "@easy-flow/pinecone-client";
import { bulkMigrate } from "./bulk-migrator.js";
import { MemoryDeleter } from "./deleter.js";
import { Migrator } from "./migrator.js";

function printUsage(): void {
  console.log(`Usage: easy-flow <command> [options]

Commands:
  migrate-memory    Migrate markdown files to Pinecone
  memory-delete     Delete memory from Pinecone
  bulk-migrate      Bulk migrate all EasyFlow instances to Pinecone

Run 'easy-flow <command> --help' for command-specific options.`);
}

function printMigrateUsage(): void {
  console.log(`Usage: easy-flow migrate-memory [options]

Options:
  --agent-id <id>            Agent ID (required)
  --source <path>            Source file or directory (repeatable)
  --exclude-pattern <glob>   Exclude files matching glob pattern (repeatable)
  --dry-run                  Preview without writing to Pinecone
  --help                     Show this help message`);
}

function printDeleteUsage(): void {
  console.log(`Usage: easy-flow memory-delete [options]

Options:
  --agent-id <id>     Agent ID (required)
  --keyword <text>    Search by keyword and delete matching chunks (semantic search)
  --source <file>     Delete chunks by exact sourceFile match
  --all               Delete all memory for this agent (DANGEROUS)
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
      "dry-run": { type: "boolean", default: false },
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
  const dryRun = values["dry-run"] as boolean;

  if (!agentId) {
    console.error("Error: --agent-id is required");
    process.exit(1);
  }
  if (sources.length === 0) {
    console.error("Error: at least one --source is required");
    process.exit(1);
  }

  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey && !dryRun) {
    console.error("Error: PINECONE_API_KEY environment variable is required");
    process.exit(1);
  }

  const client = apiKey ? new PineconeClient({ apiKey }) : noopClient();
  const migrator = new Migrator({ pineconeClient: client, agentId, dryRun, excludePatterns });

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

async function runDelete(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "agent-id": { type: "string" },
      keyword: { type: "string" },
      source: { type: "string" },
      all: { type: "boolean", default: false },
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

  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey && !dryRun) {
    console.error("Error: PINECONE_API_KEY environment variable is required");
    process.exit(1);
  }

  const client = apiKey ? new PineconeClient({ apiKey }) : noopClient();
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

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "migrate-memory") {
    await runMigrate(process.argv.slice(3));
  } else if (subcommand === "memory-delete") {
    await runDelete(process.argv.slice(3));
  } else if (subcommand === "bulk-migrate") {
    await runBulkMigrate(process.argv.slice(3));
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
