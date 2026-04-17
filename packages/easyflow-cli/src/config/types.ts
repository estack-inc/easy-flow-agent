export interface EasyflowConfig {
  registry: string;
  auth: Record<string, AuthEntry>;
}

export interface AuthEntry {
  token: string;
  expiresAt?: string; // ISO 8601
}

export const DEFAULT_CONFIG: EasyflowConfig = {
  registry: "ghcr.io",
  auth: {},
};
