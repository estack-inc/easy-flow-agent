export interface StoredImage {
  ref: string; // "estack-inc/customer-support:1.0.0"
  digest: string; // "sha256:abc123..."
  size: number; // bytes
  createdAt: string; // ISO 8601
  metadata: ImageMetadata;
}

export interface ImageMetadata {
  name: string;
  version: string;
  description: string;
  base?: { ref: string; digest?: string };
  tools: string[];
  channels: string[];
  knowledgeChunks?: number;
}

export interface ImageData {
  manifest: Record<string, unknown>;
  config: Record<string, unknown>;
  layers: Map<string, Buffer>;
}
