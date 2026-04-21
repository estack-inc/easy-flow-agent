import type { Agentfile } from "../agentfile/types.js";
import type { ImageData, StoredImage } from "../store/types.js";

export interface DeployOptions {
  ref: string;
  target: "fly";
  app: string;
  region?: string;
  org?: string;
  secretFile?: string;
  dryRun?: boolean;
}

export interface DeployResult {
  app: string;
  target: "fly";
  ref: string;
  digest: string;
  url: string;
  deployedAt: string;
  healthCheck: HealthStatus;
  knowledge?: { chunks: number; namespace: string };
}

export interface HealthStatus {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  message?: string;
}

export interface DeployAdapter {
  readonly name: "fly";
  deploy(
    image: ImageData,
    stored: StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployResult>;
  plan(
    stored: StoredImage,
    agentfile: Agentfile,
    options: DeployOptions,
    secrets: Record<string, string>,
  ): Promise<DeployPlan>;
}

export interface DeployPlan {
  app: string;
  region: string;
  org: string;
  createApp: boolean;
  createVolume: boolean;
  image: { ref: string; digest: string; size: number };
  channels: string[];
  tools: string[];
  secretKeys: string[];
}
