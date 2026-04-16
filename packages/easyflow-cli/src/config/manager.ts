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
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, "utf-8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return structuredClone(DEFAULT_CONFIG);
      }
      throw error;
    }
    return JSON.parse(raw) as EasyflowConfig;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * キー文字列をパスセグメントに分解する。
 * ブラケット記法をサポートし、キー内のドットを保護する。
 * 例:
 *   "registry"                  → ["registry"]
 *   "auth[ghcr.io].token"       → ["auth", "ghcr.io", "token"]
 *   "auth.local.token"          → ["auth", "local", "token"]
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parseKeyPath(key: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < key.length) {
    if (key[i] === "[") {
      const close = key.indexOf("]", i + 1);
      if (close === -1) {
        parts.push(key.slice(i));
        break;
      }
      parts.push(key.slice(i + 1, close));
      i = close + 1;
      if (i < key.length && key[i] === ".") {
        i++;
      }
    } else {
      const dot = key.indexOf(".", i);
      const bracket = key.indexOf("[", i);
      let end: number;
      if (dot === -1 && bracket === -1) {
        end = key.length;
      } else if (dot === -1) {
        end = bracket;
      } else if (bracket === -1) {
        end = dot;
      } else {
        end = Math.min(dot, bracket);
      }
      parts.push(key.slice(i, end));
      i = end;
      if (i < key.length && key[i] === ".") {
        i++;
      }
    }
  }
  return parts;
}

function validateKeySegments(parts: string[]): void {
  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) {
      throw new Error(`不正な設定キー: "${part}" は使用できません`);
    }
  }
}

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = parseKeyPath(key);
  validateKeySegments(parts);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateKeySegments(parts: string[]): void {
  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) {
      throw new Error(`Dangerous config key segment: "${part}"`);
    }
  }
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: string): void {
  const parts = parseKeyPath(key);
  validateKeySegments(parts);
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
