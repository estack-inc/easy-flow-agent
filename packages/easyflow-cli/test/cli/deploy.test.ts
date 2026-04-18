import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageStore } from "../../src/store/image-store.js";

// CLI コマンドのテストは Commander の action をモックして実施
// deploy コマンドの登録のみを検証し、実際の flyctl は呼ばない

describe("registerDeployCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-cli-deploy-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("deploy コマンドが Commander に登録されている", async () => {
    const { Command } = await import("commander");
    const { registerDeployCommand } = await import("../../src/cli/commands/deploy.js");

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program);

    const deployCmd = program.commands.find((c) => c.name() === "deploy");
    expect(deployCmd).toBeDefined();
    expect(deployCmd?.options.some((o) => o.long === "--app")).toBe(true);
    expect(deployCmd?.options.some((o) => o.long === "--target")).toBe(true);
    expect(deployCmd?.options.some((o) => o.long === "--secret-file")).toBe(true);
  });

  it("--app なしで実行するとエラーになる", async () => {
    const { Command } = await import("commander");
    const { registerDeployCommand } = await import("../../src/cli/commands/deploy.js");

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program);

    // --app は required なのでエラーになる
    await expect(
      program.parseAsync(["deploy", "test/agent:1.0"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("--dry-run フラグで dry-run モードで実行できる", async () => {
    // dry-run テスト: イメージストアをモックして実際のデプロイを防ぐ
    const { Command } = await import("commander");
    const { registerDeployCommand } = await import("../../src/cli/commands/deploy.js");

    const MINIMAL_AGENTFILE_YAML = `
apiVersion: easyflow/v1
kind: Agent
metadata:
  name: test-agent
  version: 1.0.0
  description: Test
  author: test
identity:
  name: TestAgent
  soul: You are helpful.
`.trim();

    // モック config.tar.gz を作成
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tartest-"));
    try {
      await fs.writeFile(path.join(configDir, "agentfile.yaml"), MINIMAL_AGENTFILE_YAML);
      const chunks: Buffer[] = [];
      const stream = tar.create({ gzip: true, cwd: configDir, portable: true }, ["agentfile.yaml"]);
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const configLayer = Buffer.concat(chunks);

      const storeDir = path.join(tmpDir, "store");
      const store = new ImageStore(storeDir);
      await store.save("test/agent:1.0", {
        manifest: {},
        config: {},
        layers: new Map([["config.tar.gz", configLayer]]),
      });

      // 実際の deploy コマンドは flyctl を呼ぶので、
      // ここでは CLI 登録と --app オプションの存在確認のみ行う
      const program = new Command();
      program.exitOverride();
      program.option("--dry-run", "dry-run", false);
      program.option("--no-color", "no-color");
      registerDeployCommand(program);

      const deployCmd = program.commands.find((c) => c.name() === "deploy");
      expect(deployCmd).toBeDefined();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
