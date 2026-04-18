import { Readable } from "node:stream";
import * as tar from "tar";
import { ImageStore } from "../store/image-store.js";
import { EasyflowError } from "../utils/errors.js";
import type { InspectReport } from "./types.js";

// tar.Parser は @types/tar v6 では型定義が不完全なため型キャストで使用
// biome-ignore lint/suspicious/noExplicitAny: tar.Parser not fully typed in @types/tar
const TarParse = (tar as Record<string, any>)["Parser"] as new (opts: {
  gzip: boolean;
}) => NodeJS.WritableStream;

/**
 * ImageStore からイメージ情報を取得して InspectReport を構築する。
 */
export async function inspectImage(ref: string, store?: ImageStore): Promise<InspectReport> {
  const imageStore = store ?? new ImageStore();
  const [data, storedImage] = await Promise.all([
    imageStore.load(ref),
    imageStore.loadStoredImage(ref),
  ]);

  if (!data) {
    throw new EasyflowError(`image not found: ${ref}`);
  }

  const { manifest, config, layers } = data;

  // config.json から各フィールドを抽出
  const cfgMetadata = (config.metadata ?? {}) as Record<string, unknown>;
  const cfgBase = config.base as { ref?: string; digest?: string } | undefined;
  const cfgKnowledge = (config.knowledge ?? { totalChunks: 0, totalTokens: 0, sources: [] }) as {
    totalChunks: number;
    totalTokens: number;
    sources: { path: string; type: string; description?: string; chunks: number; tokens: number }[];
  };
  const cfgTools = (config.tools ?? []) as string[];
  const cfgChannels = (config.channels ?? []) as string[];

  // metadata セクション
  const metadata = {
    name: (cfgMetadata.name as string) ?? "",
    version: (cfgMetadata.version as string) ?? "",
    description: (cfgMetadata.description as string) ?? "",
    author: (cfgMetadata.author as string) ?? "",
    ...(cfgBase?.ref
      ? { base: { ref: cfgBase.ref, ...(cfgBase.digest ? { digest: cfgBase.digest } : {}) } }
      : {}),
  };

  // identity セクション — identity レイヤー tar.gz から IDENTITY.md / SOUL.md / POLICY.md を読む
  const identityBuf = layers.get("identity");
  const identityFiles =
    identityBuf && identityBuf.length > 0
      ? await readTarGzFiles(identityBuf, ["IDENTITY.md", "SOUL.md", "POLICY.md"]).catch(
          () => new Map<string, string>(),
        )
      : new Map<string, string>();

  const identityName =
    parseIdentityName(identityFiles.get("IDENTITY.md") ?? "") || (cfgMetadata.name as string) || "";
  const soulText = identityFiles.get("SOUL.md") ?? "";
  const soulBody = soulText.replace(/^#[^\n]*\n\n?/, "").trim();
  const soulPreview =
    soulBody.length > 0
      ? soulBody.length > 80
        ? `${soulBody.slice(0, 80)}...`
        : soulBody
      : "(no soul)";
  const policyCount = parsePolicyCount(identityFiles.get("POLICY.md") ?? "");

  // knowledge セクション
  const knowledge = {
    totalChunks: cfgKnowledge.totalChunks ?? 0,
    totalTokens: cfgKnowledge.totalTokens ?? 0,
    sources: (cfgKnowledge.sources ?? []).map((s) => ({
      path: s.path,
      type: s.type,
      chunks: s.chunks,
      tokens: s.tokens,
    })),
  };

  // layers セクション: バッファを tar.Parse で正確にカウント
  const manifestLayers = (manifest.layers ?? []) as Array<{
    digest: string;
    size: number;
    annotations?: { "org.easyflow.layer.name"?: string };
  }>;

  const layerInfos = await Promise.all(
    manifestLayers.map(async (ml) => {
      const layerName = (ml.annotations?.["org.easyflow.layer.name"] ?? "config") as
        | "identity"
        | "knowledge"
        | "tools"
        | "config";
      const buf = layers.get(layerName);
      const size = buf?.length ?? ml.size ?? 0;
      const fileCount = buf && buf.length > 0 ? await countTarGzEntries(buf).catch(() => 0) : 0;

      return {
        name: layerName,
        size,
        fileCount,
        digest: ml.digest ?? "",
      };
    }),
  );

  // StoredImage から保存時の正確な digest / size / createdAt を取得
  const digest =
    storedImage?.digest ?? (manifest.config as { digest?: string } | undefined)?.digest ?? "";
  const totalSize = storedImage?.size ?? layerInfos.reduce((acc, l) => acc + l.size, 0);
  const createdAt =
    storedImage?.createdAt ?? (cfgMetadata.createdAt as string) ?? new Date().toISOString();

  return {
    ref,
    digest,
    size: totalSize,
    createdAt,
    metadata,
    identity: {
      name: identityName,
      soulPreview,
      policyCount,
    },
    knowledge,
    tools: cfgTools,
    channels: cfgChannels,
    layers: layerInfos,
  };
}

/** IDENTITY.md の先頭 `# <name>` 行から identity.name を取得する */
function parseIdentityName(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match?.[1]?.trim() ?? "";
}

/** POLICY.md の箇条書き（`- ...`）の行数を policyCount として返す */
function parsePolicyCount(content: string): number {
  return content.split("\n").filter((l) => /^\s*-\s+/.test(l)).length;
}

/** tar.gz バッファから指定ファイルの内容を読み出す */
async function readTarGzFiles(buf: Buffer, targetFiles: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const targetSet = new Set(targetFiles);

  await new Promise<void>((resolve, reject) => {
    const parser = new TarParse({ gzip: true });
    // biome-ignore lint/suspicious/noExplicitAny: entry is tar.ReadEntry
    parser.on("entry" as any, (entry: any) => {
      const basename = (entry.path as string).replace(/^\.\//, "").replace(/\/$/, "");
      if (targetSet.has(basename)) {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          result.set(basename, Buffer.concat(chunks).toString("utf-8"));
        });
        entry.on("error", reject);
      } else {
        entry.resume();
      }
    });
    (parser as NodeJS.EventEmitter).on("finish", resolve);
    (parser as NodeJS.EventEmitter).on("error", reject);
    Readable.from(buf).pipe(parser);
  });

  return result;
}

/** tar.gz バッファ内のファイル（非ディレクトリ）エントリ数を返す */
async function countTarGzEntries(buf: Buffer): Promise<number> {
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    const parser = new TarParse({ gzip: true });
    // biome-ignore lint/suspicious/noExplicitAny: entry is tar.ReadEntry
    parser.on("entry" as any, (entry: any) => {
      if (entry.type !== "Directory") count++;
      entry.resume();
    });
    (parser as NodeJS.EventEmitter).on("finish", resolve);
    (parser as NodeJS.EventEmitter).on("error", reject);
    Readable.from(buf).pipe(parser);
  });
  return count;
}
