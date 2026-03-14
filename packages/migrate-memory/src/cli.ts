#!/usr/bin/env node

import { parseArgs } from "node:util";
import { PineconeClient } from "@easy-flow/pinecone-client";
import { Migrator } from "./migrator.js";

function printUsage(): void {
  console.log(`Usage: easy-flow migrate-memory [options]

Options:
  --agent-id <id>     Agent ID (required)
  --source <path>     Source file or directory (repeatable)
  --dry-run           Preview without writing to Pinecone
  --help              Show this help message`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "agent-id": { type: "string" },
      source: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals[0] === "help") {
    printUsage();
    process.exit(0);
  }

  // Validate subcommand
  if (positionals[0] !== "migrate-memory") {
    if (positionals.length === 0) {
      printUsage();
      process.exit(0);
    }
    console.error(`Unknown command: ${positionals[0]}`);
    printUsage();
    process.exit(1);
  }

  const agentId = values["agent-id"] as string | undefined;
  const sources = (values.source as string[] | undefined) ?? [];
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

  const client = apiKey ? new PineconeClient({ apiKey }) : undefined;

  // For dry-run without API key, create a no-op client
  const noopClient = {
    upsert: async () => {},
    query: async () => [],
    delete: async () => {},
    deleteBySource: async () => {},
    deleteNamespace: async () => {},
    ensureIndex: async () => {},
  };

  const migrator = new Migrator({
    pineconeClient: client ?? noopClient,
    agentId,
    dryRun,
  });

  console.log(`${dryRun ? "[DRY RUN] " : ""}Migrating memory for agent: ${agentId}`);
  console.log(`Sources: ${sources.join(", ")}`);
  console.log("");

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
