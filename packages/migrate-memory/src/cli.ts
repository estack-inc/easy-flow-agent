#!/usr/bin/env node

import { parseArgs } from "node:util";
import { bulkMigrate } from "./bulk-migrator.js";
import { bulkUpdate } from "./bulk-updater.js";
import { type Backend, createClient } from "./create-client.js";
import { MemoryDeleter } from "./deleter.js";
import { ingestDocuments } from "./ingest-document.js";
import { AgentsMigrator } from "./migrate-agents.js";
import { Migrator } from "./migrator.js";
import { migrateConversationMemory, pineconeHeaders } from "./pinecone-to-pgvector.js";
import { validateExcludePatterns } from "./preflight.js";

function printUsage(): void {
  console.log(`Usage: easy-flow <command> [options]

Commands:
  migrate-memory        Migrate markdown files to vector DB
  agents                Migrate AGENTS.md to vector DB (section-based chunking)
  ingest-document       Ingest text/markdown documents into vector DB
  memory-delete         Delete memory from vector DB
  pinecone-to-pgvector  Migrate conversation memory from Pinecone to pgvector
  bulk-migrate          Bulk migrate all EasyFlow instances
  bulk-update           Bulk update easy-flow-agent on all instances

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

function printPineconeToPgvectorUsage(): void {
  console.log(`Usage: easy-flow pinecone-to-pgvector [options]

Migrate conversation memory (session_turn) from Pinecone to pgvector.
AGENTS.md rules (agents_rule, memory_file) are skipped as they are already
migrated via the 'agents' command.

Text is re-embedded using Gemini (768-dim) since Pinecone uses 1024-dim vectors.

Options:
  --namespace <ns>      Pinecone namespace to migrate (repeatable, e.g. agent:mell)
                        If not specified, migrates all namespaces from Pinecone
  --pinecone-host <h>   Pinecone data plane host (auto-detected if omitted)
  --dry-run             Preview without writing to pgvector
  --include-all-types   Include all sourceTypes (not just session_turn/conversation)
  --help                Show this help message

Environment Variables (all required):
  PINECONE_API_KEY         Pinecone API key (with list/fetch permissions)
  PGVECTOR_DATABASE_URL    pgvector connection string
  GEMINI_API_KEY           Gemini API key for re-embedding`);
}

async function runPineconeToPgvector(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      namespace: { type: "string", multiple: true },
      "pinecone-host": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "include-all-types": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printPineconeToPgvectorUsage();
    process.exit(0);
  }

  const dryRun = values["dry-run"] as boolean;
  const includeAllTypes = values["include-all-types"] as boolean;

  const pineconeApiKey = process.env.PINECONE_API_KEY;
  if (!pineconeApiKey) {
    console.error("Error: PINECONE_API_KEY environment variable is required");
    process.exit(1);
  }

  const pgvectorClient = createClient("pgvector", dryRun);

  // Resolve Pinecone host
  let pineconeHost = values["pinecone-host"] as string | undefined;

  if (!pineconeHost) {
    console.log("🔍 Discovering Pinecone index host...");
    const indexRes = await fetch("https://api.pinecone.io/indexes", {
      headers: pineconeHeaders(pineconeApiKey),
    });

    if (!indexRes.ok) {
      console.error(
        `Error: Failed to discover Pinecone host (${indexRes.status}). Specify --pinecone-host explicitly.`,
      );
      process.exit(1);
    }

    const indexData = (await indexRes.json()) as {
      indexes: { name: string; host: string }[];
    };
    const idx = indexData.indexes.find((i) => i.name === "easy-flow-memory");
    if (!idx) {
      console.error("Error: easy-flow-memory index not found in Pinecone");
      process.exit(1);
    }
    pineconeHost = idx.host;
  }

  // Discover namespaces if not specified
  let namespaces = (values.namespace as string[] | undefined) ?? [];

  if (namespaces.length === 0) {
    console.log("📋 Discovering namespaces from Pinecone...");
    const statsRes = await fetch(`https://${pineconeHost}/describe_index_stats`, {
      method: "POST",
      headers: { ...pineconeHeaders(pineconeApiKey), "Content-Type": "application/json" },
      body: "{}",
    });

    if (!statsRes.ok) {
      console.error(`Error: Failed to get Pinecone stats: ${statsRes.status}`);
      process.exit(1);
    }

    const stats = (await statsRes.json()) as {
      namespaces: Record<string, { vectorCount: number }>;
    };
    namespaces = Object.keys(stats.namespaces).sort(
      (a, b) => (stats.namespaces[b].vectorCount ?? 0) - (stats.namespaces[a].vectorCount ?? 0),
    );

    console.log(`  Found ${namespaces.length} namespaces`);
    for (const ns of namespaces) {
      console.log(`    ${ns}: ${stats.namespaces[ns].vectorCount} vectors`);
    }
  }

  const sourceTypes = includeAllTypes ? undefined : ["session_turn", "conversation"];

  const results = await migrateConversationMemory({
    pineconeApiKey,
    pineconeHost,
    pgvectorClient,
    namespaces,
    dryRun,
    sourceTypes,
  });

  const hasErrors = results.some((r) => r.errors > 0);
  if (hasErrors) {
    process.exitCode = 1;
  }
}

function printIngestDocumentUsage(): void {
  console.log(`Usage: easy-flow ingest-document [options] <source...>

Ingest documents into pgvector for RAG retrieval.

Arguments:
  <source...>           One or more file paths or URLs to ingest

Supported formats:
  Text/Markdown         .txt, .md, .markdown, .text
  Office                .docx, .xlsx, .pptx
  PDF                   .pdf
  URL                   http:// or https:// (HTML pages)
  Google Docs           https://docs.google.com/document/d/...
  Google Sheets         https://docs.google.com/spreadsheets/d/...
  Google Slides         https://docs.google.com/presentation/d/...

Options:
  --namespace <name>    Agent namespace (e.g. "agent:mell") [required]
  --category <name>     Document category for filtering (e.g. "manual", "faq", "policy")
  --dry-run             Show what would be ingested without writing to DB
  --help                Show this help message

Environment Variables:
  PGVECTOR_DATABASE_URL  Required
  GEMINI_API_KEY         Required

Examples:
  easy-flow ingest-document --namespace agent:mell manual.md
  easy-flow ingest-document --namespace agent:mell --category faq faq.txt guide.docx
  easy-flow ingest-document --namespace agent:mell report.pdf slides.pptx data.xlsx
  easy-flow ingest-document --namespace agent:mell https://example.com/page
  easy-flow ingest-document --namespace agent:mell https://docs.google.com/document/d/xxx
  easy-flow ingest-document --namespace agent:mell --dry-run *.md`);
}

async function runIngestDocument(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      namespace: { type: "string" },
      category: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printIngestDocumentUsage();
    process.exit(0);
  }

  const namespace = values.namespace as string | undefined;
  if (!namespace) {
    console.error("Error: --namespace is required (e.g. --namespace agent:mell)");
    process.exit(1);
  }

  // Extract agentId from namespace (e.g. "agent:mell" → "mell")
  const agentId = namespace.startsWith("agent:") ? namespace.slice(6) : namespace;

  const filePaths = positionals;
  if (filePaths.length === 0) {
    console.error("Error: At least one file path is required");
    process.exit(1);
  }

  const dryRun = values["dry-run"] as boolean;
  const force = values.force as boolean;
  const category = values.category as string | undefined;

  const pgvectorClient = createClient("pgvector", dryRun);

  const { errors } = await ingestDocuments({
    filePaths,
    agentId,
    pgvectorClient,
    category,
    dryRun,
    force,
  });

  if (errors.length > 0) {
    process.exit(1);
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
  } else if (subcommand === "ingest-document") {
    await runIngestDocument(process.argv.slice(3));
  } else if (subcommand === "memory-delete") {
    await runDelete(process.argv.slice(3));
  } else if (subcommand === "pinecone-to-pgvector") {
    await runPineconeToPgvector(process.argv.slice(3));
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
