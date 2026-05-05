import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/style/useTemplate: 意図的に文字列連結（template literal の lint 警告回避）
const placeholder = (name: string): string => "$" + "{" + name + "}";

describe("render-openclaw-config.js", () => {
  let tmpDir: string;
  const scriptPath = path.resolve(
    import.meta.dirname,
    "../../src/deploy/render-openclaw-config.js",
  );

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-render-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("プレースホルダを環境変数で展開する", async () => {
    const templatePath = path.join(tmpDir, "config.template");
    const outputPath = path.join(tmpDir, "config.json");

    const template = JSON.stringify({
      channels: {
        slack: {
          botToken: placeholder("SLACK_BOT_TOKEN"),
          signingSecret: placeholder("SLACK_SIGNING_SECRET"),
        },
        line: {
          accessToken: placeholder("LINE_ACCESS_TOKEN"),
          channelSecret: placeholder("LINE_CHANNEL_SECRET"),
        },
      },
    });
    await fs.writeFile(templatePath, template);

    execSync(`node "${scriptPath}" "${templatePath}" "${outputPath}"`, {
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: "xoxb-test-token",
        SLACK_SIGNING_SECRET: "sign-secret",
        LINE_ACCESS_TOKEN: "line-access",
        LINE_CHANNEL_SECRET: "line-secret",
      },
    });

    const output = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(output);

    expect(parsed.channels.slack.botToken).toBe("xoxb-test-token");
    expect(parsed.channels.slack.signingSecret).toBe("sign-secret");
    expect(parsed.channels.line.accessToken).toBe("line-access");
    expect(parsed.channels.line.channelSecret).toBe("line-secret");
  });

  it("環境変数が未設定の場合は fail-fast する", async () => {
    const templatePath = path.join(tmpDir, "config.template");
    const outputPath = path.join(tmpDir, "config.json");

    const template = JSON.stringify({
      token: placeholder("GATEWAY_TOKEN"),
      present: placeholder("SLACK_BOT_TOKEN"),
    });
    await fs.writeFile(templatePath, template);

    expect(() =>
      execSync(`node "${scriptPath}" "${templatePath}" "${outputPath}"`, {
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: "value",
          GATEWAY_TOKEN: undefined,
        },
      }),
    ).toThrow();

    await expect(fs.readFile(outputPath, "utf-8")).rejects.toThrow();
  });

  it("プレースホルダがない場合はそのまま出力される", async () => {
    const templatePath = path.join(tmpDir, "config.template");
    const outputPath = path.join(tmpDir, "config.json");

    const template = JSON.stringify({
      gateway: { auth: { mode: "token", token: "fixed-token" } },
    });
    await fs.writeFile(templatePath, template);

    execSync(`node "${scriptPath}" "${templatePath}" "${outputPath}"`, {
      env: process.env,
    });

    const output = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(output);

    expect(parsed.gateway.auth.token).toBe("fixed-token");
  });

  it("許可されていないプレースホルダは展開せず missing 扱いにしない", async () => {
    const templatePath = path.join(tmpDir, "config.template");
    const outputPath = path.join(tmpDir, "config.json");

    const template = JSON.stringify({
      agents: { default: { model: placeholder("MODEL_NAME") } },
      channels: { webchat: { invite_codes: [placeholder("INVITE_CODE")] } },
      gateway: { auth: { token: placeholder("GATEWAY_TOKEN") } },
    });
    await fs.writeFile(templatePath, template);

    execSync(`node "${scriptPath}" "${templatePath}" "${outputPath}"`, {
      env: {
        ...process.env,
        GATEWAY_TOKEN: "gateway-token",
        MODEL_NAME: undefined,
        INVITE_CODE: undefined,
      },
    });

    const output = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(output);

    expect(parsed.agents.default.model).toBe(placeholder("MODEL_NAME"));
    expect(parsed.channels.webchat.invite_codes).toEqual([placeholder("INVITE_CODE")]);
    expect(parsed.gateway.auth.token).toBe("gateway-token");
  });

  it("環境変数に JSON 特殊文字が含まれても有効な JSON として出力される", async () => {
    const templatePath = path.join(tmpDir, "config.template");
    const outputPath = path.join(tmpDir, "config.json");

    const template = JSON.stringify({
      channels: {
        slack: {
          botToken: placeholder("SLACK_BOT_TOKEN"),
        },
      },
      message: `prefix:${placeholder("SLACK_BOT_TOKEN")}`,
    });
    await fs.writeFile(templatePath, template);

    execSync(`node "${scriptPath}" "${templatePath}" "${outputPath}"`, {
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: 'token"with\\chars\nnext',
      },
    });

    const output = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(output);

    expect(parsed.channels.slack.botToken).toBe('token"with\\chars\nnext');
    expect(parsed.message).toBe('prefix:token"with\\chars\nnext');
  });
});
