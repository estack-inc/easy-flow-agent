import type { Agentfile } from "../agentfile/types.js";

/** ビルドオプション（CLI から渡される） */
export interface BuildOptions {
  /** Agentfile のパス */
  agentfilePath: string;
  /** タグ付き ref（例: "estack-inc/support:1.0"） */
  ref: string;
  /** ビルドキャッシュを無効化 */
  noCache?: boolean;
  /** ドライラン（ファイル書き込みなし） */
  dryRun?: boolean;
}

/** ビルド結果 */
export interface BuildResult {
  ref: string;
  digest: string;
  size: number;
  layers: LayerInfo[];
  createdAt: string;
}

export type LayerName = "identity" | "knowledge" | "tools" | "config";

export interface LayerInfo {
  name: LayerName;
  digest: string;
  size: number;
  fileCount: number;
}

/** OCI Image Manifest v2 */
export interface OciManifest {
  schemaVersion: 2;
  mediaType: "application/vnd.easyflow.agent.manifest.v1+json";
  config: OciDescriptor;
  layers: OciLayerDescriptor[];
  annotations?: Record<string, string>;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
}

export interface OciLayerDescriptor extends OciDescriptor {
  annotations?: { "org.easyflow.layer.name"?: string };
}

/** config.json 形式（設計書 §3.2） */
export interface ImageConfigFile {
  schemaVersion: 1;
  agentfile: "easyflow/v1";
  metadata: {
    name: string;
    version: string;
    description: string;
    author: string;
    createdAt: string;
    buildTool: string;
  };
  base?: { ref: string; digest?: string };
  knowledge: {
    totalChunks: number;
    totalTokens: number;
    sources: KnowledgeSourceStats[];
  };
  tools: string[];
  channels: string[];
}

export interface KnowledgeSourceStats {
  path: string;
  type: string;
  description?: string;
  chunks: number;
  tokens: number;
}

/** レイヤー生成結果（各レイヤービルダーが返す共通型） */
export interface LayerData {
  /** tar.gz バイナリ */
  content: Buffer;
  /** "sha256:..." */
  digest: string;
  size: number;
  fileCount: number;
}

export type { Agentfile };
