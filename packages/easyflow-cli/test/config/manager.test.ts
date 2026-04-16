import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../src/config/manager.js";
import { DEFAULT_CONFIG } from "../../src/config/types.js";

describe("ConfigManager", () => {
  let tmpDir: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-config-test-"));
    manager = new ConfigManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("設定ファイルなし → デフォルト設定が返る", async () => {
    const config = await manager.load();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("set → get で値が取得できる", async () => {
    await manager.set("registry", "custom.io");
    const value = await manager.get("registry");
    expect(value).toBe("custom.io");
  });

  it("ネストキーの set → get（ブラケット記法で FQDN を保護）", async () => {
    await manager.set("auth[ghcr.io].token", "abc");
    const value = await manager.get("auth[ghcr.io].token");
    expect(value).toBe("abc");

    // 保存形式が型定義 auth: Record<string, AuthEntry> と一致することを確認
    const config = await manager.load();
    expect(config.auth["ghcr.io"]).toEqual({ token: "abc" });
  });

  it("存在しないキー → undefined", async () => {
    const value = await manager.get("unknown.key");
    expect(value).toBeUndefined();
  });

  it("save → 新インスタンスで load → 同じ値が返る", async () => {
    await manager.set("registry", "custom.io");

    const newManager = new ConfigManager(tmpDir);
    const config = await newManager.load();
    expect(config.registry).toBe("custom.io");
  });

  it("壊れた config.json → JSON parse error をそのまま投げる", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.json"), "{ invalid json }");

    await expect(manager.load()).rejects.toThrow(SyntaxError);
  });
});
