export interface InspectReport {
  ref: string;
  digest: string;
  size: number;
  createdAt: string;
  metadata: {
    name: string;
    version: string;
    description: string;
    author: string;
    base?: { ref: string; digest?: string };
  };
  identity: {
    name: string;
    soulPreview: string;
    policyCount: number;
  };
  knowledge: {
    totalChunks: number;
    totalTokens: number;
    sources: { path: string; type: string; chunks: number; tokens: number }[];
  };
  tools: string[];
  channels: string[];
  layers: {
    name: "identity" | "knowledge" | "tools" | "config";
    size: number;
    fileCount: number;
    digest: string;
  }[];
}
