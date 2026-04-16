import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EasyflowConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export class ConfigManager {
  private configPath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir =
      configDir ?? process.env.EASYFLOW_CONFIG_DIR ?? path.join(os.homedir(), ".easyflow");
    this.configPath = path.join(this.configDir, "config.json");
  }

  async load(): Promise<EasyflowConfig> {
    try {
      const raw = await fs.readFile(this.configPath, "utf-8");
      return JSON.parse(raw) as EasyflowConfig;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  async save(config: EasyflowConfig): Promise<void> {
    await this.ensureConfigDir();
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async get(key: string): Promise<string | undefined> {
    const config = await this.load();
    const value = getNestedValue(config, key);
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  async set(key: string, value: string): Promise<void> {
    const config = await this.load();
    setNestedValue(config, key, value);
    await this.save(config);
  }

  async ensureConfigDir(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
  }
}

/**
 * ドット記法でネストされた値を取得する。
 * 注意: キー自体にドットを含む場合（例: "ghcr.io"）は区切り文字と区別できない。
 * Phase 1 の制限事項として、FQDN をキーに使う場合は構造を工夫する必要がある。
 */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === undefined ||
      current[part] === null ||
      typeof current[part] !== "object"
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
