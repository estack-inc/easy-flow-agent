import * as path from "node:path";
import { parseAgentfile } from "../agentfile/parser.js";
import type { ImageStore } from "../store/image-store.js";
import { EasyflowError } from "../utils/errors.js";
import type { DeploymentsLog } from "./deployments-log.js";
import { extractLayer } from "./layer-extractor.js";
import { loadSecretFile } from "./secret-file.js";
import type { DeployAdapter, DeployOptions, DeployPlan, DeployResult } from "./types.js";

export class Deployer {
  constructor(
    private store: ImageStore,
    private adapters: Map<"fly", DeployAdapter>,
    private log: DeploymentsLog,
  ) {}

  async deploy(options: DeployOptions): Promise<DeployResult> {
    // Step 1: イメージをロード
    const imageData = await this.store.load(options.ref);
    if (!imageData) {
      throw new EasyflowError(
        `image not found: ${options.ref}`,
        "指定された ref のイメージがローカルストアに存在しません",
        "easyflow build でイメージをビルドしてください",
      );
    }

    // stored イメージのメタ情報を取得（list から検索）
    const storedList = await this.store.list();
    const stored = storedList.find((s) => s.ref === options.ref);
    if (!stored) {
      throw new EasyflowError(`image metadata not found: ${options.ref}`);
    }

    // Step 2: config レイヤーから Agentfile を展開
    const agentfile = await this.extractAgentfile(imageData.layers);

    // Step 3: シークレットファイルをロード
    const secrets: Record<string, string> = {};
    if (options.secretFile) {
      const fileSecrets = await loadSecretFile(options.secretFile);
      Object.assign(secrets, fileSecrets);
    }

    // Step 4: アダプターを取得
    const adapter = this.adapters.get(options.target);
    if (!adapter) {
      throw new EasyflowError(
        `unsupported target: ${options.target}`,
        "現在サポートされているターゲットは 'fly' のみです",
      );
    }

    // Step 5: デプロイ実行
    const result = await adapter.deploy(imageData, stored, agentfile, options, secrets);

    // Step 6: デプロイ履歴を記録
    await this.log.append({
      app: result.app,
      target: result.target,
      image: result.ref,
      digest: result.digest,
      deployedAt: result.deployedAt,
      knowledge: result.knowledge
        ? {
            chunks: result.knowledge.chunks,
            liveChunks: result.knowledge.chunks,
            namespace: result.knowledge.namespace,
          }
        : { chunks: 0, liveChunks: 0, namespace: result.app },
    });

    return result;
  }

  async plan(options: DeployOptions): Promise<DeployPlan> {
    const imageData = await this.store.load(options.ref);
    if (!imageData) {
      throw new EasyflowError(`image not found: ${options.ref}`);
    }

    const storedList = await this.store.list();
    const stored = storedList.find((s) => s.ref === options.ref);
    if (!stored) {
      throw new EasyflowError(`image metadata not found: ${options.ref}`);
    }

    const agentfile = await this.extractAgentfile(imageData.layers);

    const adapter = this.adapters.get(options.target);
    if (!adapter) {
      throw new EasyflowError(`unsupported target: ${options.target}`);
    }

    return adapter.plan(stored, agentfile, options);
  }

  private async extractAgentfile(
    layers: Map<string, Buffer>,
  ): Promise<import("../agentfile/types.js").Agentfile> {
    // config.tar.gz から agentfile.yaml を取り出す
    const configLayer = layers.get("config.tar.gz");
    if (configLayer) {
      try {
        const extracted = await extractLayer(configLayer);
        const yamlBuf = extracted.files.get("agentfile.yaml");
        if (yamlBuf) {
          const result = await parseAgentfile(yamlBuf.toString("utf-8"), {
            basedir: process.cwd(),
          });
          return result.agentfile;
        }
      } catch {
        // config.tar.gz からの抽出に失敗した場合は config.json を試みる
      }
    }

    // config.json から直接パース（ビルド時に埋め込まれた Agentfile JSON）
    // image.config は Record<string, unknown> なので agentfile キーを探す
    // ここでは ImageData.config を使う
    throw new EasyflowError(
      "Agentfile をイメージから取得できませんでした",
      "config.tar.gz 内に agentfile.yaml が見つかりません",
      "easyflow build で正しくビルドされたイメージを使用してください",
    );
  }
}
