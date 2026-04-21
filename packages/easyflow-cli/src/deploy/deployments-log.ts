import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface DeploymentEntry {
  app: string;
  target: "fly";
  image: string;
  digest: string;
  deployedAt: string;
  knowledge: {
    chunks: number;
    liveChunks: number;
    namespace: string;
  };
}

interface LogFile {
  deployments: DeploymentEntry[];
}

/**
 * デプロイ履歴を ~/.easyflow/deployments.json に記録する。
 */
export class DeploymentsLog {
  private readonly filepath: string;

  constructor(filepath?: string) {
    this.filepath = filepath ?? path.join(os.homedir(), ".easyflow", "deployments.json");
  }

  async append(entry: DeploymentEntry): Promise<void> {
    const existing = await this.readFile();
    existing.deployments.push(entry);
    await this.writeFile(existing);
  }

  async list(): Promise<DeploymentEntry[]> {
    const data = await this.readFile();
    return data.deployments;
  }

  async find(app: string): Promise<DeploymentEntry | undefined> {
    const data = await this.readFile();
    const matching = data.deployments.filter((e) => e.app === app);
    if (matching.length === 0) return undefined;

    // deployedAt で降順ソートして最新を返す
    matching.sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));
    return matching[0];
  }

  private async readFile(): Promise<LogFile> {
    try {
      const content = await fs.readFile(this.filepath, "utf-8");
      const parsed = JSON.parse(content) as LogFile;
      if (!Array.isArray(parsed.deployments)) {
        return { deployments: [] };
      }
      return parsed;
    } catch {
      return { deployments: [] };
    }
  }

  private async writeFile(data: LogFile): Promise<void> {
    const dir = path.dirname(this.filepath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.filepath}.tmp.${Date.now()}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpPath, this.filepath);
    } catch (err) {
      // クリーンアップを試みる
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
