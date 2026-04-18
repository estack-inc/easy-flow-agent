import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageStore } from "../../src/store/image-store.js";
import type { ImageData } from "../../src/store/types.js";

const execFileAsync = promisify(execFile);
const ENTRY_PATH = path.resolve(import.meta.dirname, "../../src/cli/index.ts");

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", ENTRY_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function createTestImageData(): ImageData {
  return {
    manifest: {
      schemaVersion: 2,
      config: { digest: "sha256:configdigest", size: 100 },
      layers: [
        {
          digest: "sha256:identity123",
          size: 512,
          annotations: { "org.easyflow.layer.name": "identity" },
        },
        {
          digest: "sha256:config123",
          size: 128,
          annotations: { "org.easyflow.layer.name": "config" },
        },
      ],
    },
    config: {
      schemaVersion: 1,
      agentfile: "easyflow/v1",
      metadata: {
        name: "test-agent",
        version: "1.0.0",
        description: "CLI inspect test agent",
        author: "tester",
        createdAt: "2026-04-17T00:00:00.000Z",
        buildTool: "easyflow-cli/0.1.0",
      },
      knowledge: { totalChunks: 0, totalTokens: 0, sources: [] },
      tools: ["workflow-controller"],
      channels: ["slack"],
    },
    layers: new Map([
      ["identity", Buffer.from("identity-tar-gz")],
      ["config", Buffer.from("config-tar-gz")],
    ]),
  };
}

describe("easyflow inspect (CLI)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-inspect-cli-test-"));
    const store = new ImageStore(storeDir);
    await store.save("org/inspect-test:1.0.0", createTestImageData());
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("存在する ref で exit code 0 が返る", async () => {
    const { code, stdout } = await runCli(["inspect", "org/inspect-test:1.0.0"], {
      EASYFLOW_STORE_DIR: storeDir,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("=== Image ===");
  });

  it("存在しない ref で exit code 1 が返る", async () => {
    const { code, stderr } = await runCli(["inspect", "org/missing:1.0.0"], {
      EASYFLOW_STORE_DIR: storeDir,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("image not found");
  });

  it("--json で JSON 形式の出力が得られる", async () => {
    const { code, stdout } = await runCli(["inspect", "org/inspect-test:1.0.0", "--json"], {
      EASYFLOW_STORE_DIR: storeDir,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ref).toBe("org/inspect-test:1.0.0");
    expect(parsed.metadata).toBeDefined();
    expect(parsed.layers).toBeDefined();
  });
});
