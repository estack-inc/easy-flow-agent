import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
import { TextChunker } from "@easy-flow/pinecone-client";
import picomatch from "picomatch";
import { runPreflight } from "./preflight.js";

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
  private readonly force: boolean;
  private readonly chunker: TextChunker;
  private readonly isExcluded: (filePath: string) => boolean;

  constructor(params: {
    pineconeClient: IPineconeClient;
    agentId: string;
    dryRun?: boolean;
    force?: boolean;
    excludePatterns?: string[];
  }) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.dryRun = params.dryRun ?? false;
    this.force = params.force ?? false;
    this.chunker = new TextChunker();
    this.isExcluded =
      params.excludePatterns && params.excludePatterns.length > 0
        ? picomatch(params.excludePatterns)
        : () => false;
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

    // pre-flight チェック
    const preflightResults = await runPreflight(files);
    if (preflightResults.hasSecrets) {
      if (!this.force) {
        throw new Error(
          `[PREFLIGHT ERROR] 機密情報のパターンが検出されました。\n` +
            `投入を中止します。--force フラグで強制続行できますが推奨しません。\n` +
            preflightResults.results
              .filter((r) => r.secrets.length > 0)
              .map((r) => `  ${r.file}: ${r.secrets.join(", ")}`)
              .join("\n"),
        );
      }
      console.warn("[PREFLIGHT WARN] --force が指定されたため機密情報検出を無視して続行します:");
      for (const r of preflightResults.results.filter((r) => r.secrets.length > 0)) {
        console.warn(`  ${r.file}: ${r.secrets.join(", ")}`);
      }
    }
    // 品質警告は --dry-run 時も表示
    for (const r of preflightResults.results) {
      for (const w of r.warnings) {
        console.warn(`[PREFLIGHT WARN] ${r.file}: ${w}`);
      }
    }

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
          category: this.getCategoryFromPath(file),
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

  private async collectFiles(sources: string[], skippedFiles: string[]): Promise<string[]> {
    const files: string[] = [];

    for (const source of sources) {
      try {
        const s = await stat(source);
        if (s.isDirectory()) {
          await this.scanDirectory(source, files);
        } else if (source.endsWith(".md") && !this.isExcluded(source)) {
          files.push(source);
        }
      } catch {
        skippedFiles.push(source);
      }
    }

    return files;
  }

  /**
   * ファイルパスからカテゴリを動的に判定する。
   * assemble() のフィルタリングと重み付けに使用される。
   *
   * - daily: memory/daily/YYYY-MM-DD.md または memory/YYYY-MM-DD.md（ミノ形式）
   * - project: memory/projects/ 配下のファイル
   * - memory_index: MEMORY.md / MEMORY-WORK.md
   * - undefined: その他（カテゴリなし）
   */
  private getCategoryFromPath(filePath: string): string | undefined {
    const normalizedPath = filePath.replace(/\\/g, "/");

    // daily ログ: memory/daily/YYYY-MM-DD.md または memory/YYYY-MM-DD.md
    if (/memory\/(daily\/)?(\d{4}-\d{2}-\d{2})\.md$/.test(normalizedPath)) {
      return "daily";
    }

    // projects ディレクトリ配下
    if (/\/memory\/projects\//.test(normalizedPath)) {
      return "project";
    }

    // MEMORY.md / MEMORY-WORK.md（インデックスファイル）
    if (/\/(MEMORY|MEMORY-WORK)\.md$/.test(normalizedPath)) {
      return "memory_index";
    }

    return undefined;
  }

  private async scanDirectory(dir: string, files: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (this.isExcluded(fullPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, files);
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
}
