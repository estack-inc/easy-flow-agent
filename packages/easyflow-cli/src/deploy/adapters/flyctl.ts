import { execa } from "execa";
import { EasyflowError } from "../../utils/errors.js";

/**
 * flyctl CLI のラッパー。
 */
export class FlyctlRunner {
  constructor(private log: (line: string) => void) {}

  async apps(args: string[]): Promise<string> {
    return this.run(["apps", ...args]);
  }

  async volumes(args: string[]): Promise<string> {
    return this.run(["volumes", ...args]);
  }

  async secretsImport(
    appName: string,
    content: string,
    options?: { stage?: boolean },
  ): Promise<void> {
    const args = ["secrets", "import", "--app", appName];
    if (options?.stage) {
      args.push("--stage");
    }

    await this.run(args, {
      input: content,
      redactValues: parseSecretImportValues(content),
    });
  }

  async secretsList(appName: string): Promise<string> {
    return this.run(["secrets", "list", "--app", appName, "--json"]);
  }

  async deploy(
    appName: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<void> {
    await this.run(["deploy", "--app", appName, ...args], {
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });
  }

  async ssh(appName: string, command: string[]): Promise<string> {
    return this.run(["ssh", "console", "--app", appName, "-C", command.join(" ")]);
  }

  async machines(args: string[]): Promise<string> {
    return this.run(["machines", ...args]);
  }

  private async run(
    args: string[],
    options?: { timeoutMs?: number; cwd?: string; input?: string; redactValues?: string[] },
  ): Promise<string> {
    try {
      const result = await execa("flyctl", args, {
        reject: true,
        all: true,
        cwd: options?.cwd,
        timeout: options?.timeoutMs,
        input: options?.input,
      });

      const output = result.all ?? result.stdout ?? "";
      const redactedOutput = redactValues(output, options?.redactValues);
      for (const line of redactedOutput.split("\n")) {
        if (line.trim()) {
          this.log(line);
        }
      }
      return output;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new EasyflowError(
          "flyctl が見つかりません",
          "flyctl がインストールされていないか、PATH に含まれていません",
          "https://fly.io/docs/hands-on/install-flyctl/ からインストールしてください",
        );
      }

      // execa error — stderr を含めて再スロー
      const execaErr = err as { stderr?: string; all?: string; message?: string };
      const detail = redactValues(
        execaErr.stderr ?? execaErr.all ?? execaErr.message ?? String(err),
        options?.redactValues,
      );
      throw new EasyflowError(`flyctl コマンドが失敗しました: flyctl ${args[0]}`, detail);
    }
  }
}

function parseSecretImportValues(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separatorIndex = line.indexOf("=");
      return separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    })
    .filter(Boolean);
}

function redactValues(value: string, values?: string[]): string {
  let redacted = value;
  for (const secret of values ?? []) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
