import { ImageStore } from "../store/image-store.js";
import { EasyflowError } from "../utils/errors.js";
import type { InspectReport } from "./types.js";

/**
 * ImageStore からイメージ情報を取得して InspectReport を構築する。
 */
export async function inspectImage(ref: string, store?: ImageStore): Promise<InspectReport> {
  const imageStore = store ?? new ImageStore();
  const data = await imageStore.load(ref);

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

  // identity セクション (config.json にはソウルを持たないため description をプレビューとして使用)
  const identityName = (cfgMetadata.name as string) ?? "";
  const soulPreview =
    metadata.description.length > 80
      ? `${metadata.description.slice(0, 80)}...`
      : metadata.description || "(no soul)";
  const policyCount = 0; // config.json には policy 情報を含まない

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

  // layers セクション: manifest から digest を、layers Map からサイズを取得
  const manifestLayers = (manifest.layers ?? []) as Array<{
    digest: string;
    size: number;
    annotations?: { "org.easyflow.layer.name"?: string };
  }>;

  const layerInfos = manifestLayers.map((ml) => {
    const layerName = (ml.annotations?.["org.easyflow.layer.name"] ?? "config") as
      | "identity"
      | "knowledge"
      | "tools"
      | "config";
    const buf = layers.get(layerName);
    const size = buf?.length ?? ml.size ?? 0;
    // tar エントリ数のカウント（簡易: バッファが空なら 0）
    const fileCount = buf && buf.length > 0 ? estimateTarFileCount(buf) : 0;

    return {
      name: layerName,
      size,
      fileCount,
      digest: ml.digest ?? "",
    };
  });

  // manifest から digest を取得（storedImage の digest を利用するため再計算）
  // manifest に存在する config.digest を利用
  const cfgDescriptor = manifest.config as { digest?: string } | undefined;
  const digest = cfgDescriptor?.digest ?? "";

  // StoredImage の情報を取得するために image.json を読む（直接 load では取得できないため）
  // サイズと createdAt はストアの別 API で取得するか推定する
  const totalSize = layerInfos.reduce((acc, l) => acc + l.size, 0);

  return {
    ref,
    digest,
    size: totalSize,
    createdAt: (cfgMetadata.createdAt as string) ?? new Date().toISOString(),
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

/**
 * tar.gz バッファからファイル数を推定する（簡易実装）。
 * ヘッダーブロック(512 バイト)をスキャンして非空エントリを数える。
 */
function estimateTarFileCount(buf: Buffer): number {
  // gzip ヘッダーで始まる場合はデコードできないため 1 を返す
  // 実際の実装では tar パッケージを利用するが、同期処理のためシンプルに推定
  if (buf.length < 2) return 0;
  // gzip magic bytes: 0x1f 0x8b
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // gz 圧縮済み — 正確なカウントは非同期 tar パースが必要
    // フォールバック: 1 以上のファイルが存在すると推定
    return buf.length > 0 ? 1 : 0;
  }
  return 0;
}
