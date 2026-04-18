import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAgentfile } from "../agentfile/parser.js";
import type { Agentfile } from "../agentfile/types.js";
import type { ImageStore } from "../store/image-store.js";
import type { ImageData, StoredImage } from "../store/types.js";
import { buildConfigLayer } from "./layers/config.js";
import { buildIdentityLayer } from "./layers/identity.js";
import { buildKnowledgeLayer } from "./layers/knowledge.js";
import { buildToolsLayer } from "./layers/tools.js";
import {
  buildImageConfig,
  buildOciManifest,
  CONFIG_MEDIA_TYPE,
  enabledChannelNames,
  LAYER_MEDIA_TYPE,
} from "./oci.js";
import type {
  BuildOptions,
  BuildResult,
  ImageConfigFile,
  LayerData,
  LayerInfo,
  LayerName,
  OciDescriptor,
} from "./types.js";

export interface BuildPlan {
  ref: string;
  agentfile: Agentfile;
  resolvedBase?: string;
  channels: string[];
  builtinTools: string[];
  customToolNames: string[];
}

export interface BuildOptionsInternal extends BuildOptions {
  /** テスト用の時刻注入（省略時は現在時刻） */
  now?: Date;
}

const LAYER_ORDER: LayerName[] = ["identity", "knowledge", "tools", "config"];

/**
 * Agentfile からエージェントイメージをビルドし、ImageStore に保存する。
 */
export class ImageBuilder {
  constructor(private store: ImageStore) {}

  /**
   * 事前に Agentfile をパースしてビルド計画のみを返す（--dry-run 用）。
   */
  async plan(options: BuildOptionsInternal): Promise<BuildPlan> {
    const { agentfile, resolvedBase } = await this.parse(options.agentfilePath);
    return {
      ref: options.ref,
      agentfile,
      resolvedBase,
      channels: enabledChannelNames(agentfile),
      builtinTools: agentfile.tools?.builtin ?? [],
      customToolNames: (agentfile.tools?.custom ?? []).map((t) => t.name),
    };
  }

  async build(options: BuildOptionsInternal): Promise<BuildResult> {
    const createdAt = (options.now ?? new Date()).toISOString();
    const agentfilePath = path.resolve(options.agentfilePath);
    const basedir = path.dirname(agentfilePath);

    const rawContent = await fs.readFile(agentfilePath, "utf-8");
    const { agentfile, resolvedBase } = await parseAgentfile(rawContent, { basedir });

    // 4 レイヤーを並列生成
    const [identity, knowledge, tools, config] = await Promise.all([
      buildIdentityLayer(agentfile, basedir),
      buildKnowledgeLayer(agentfile),
      buildToolsLayer(agentfile, basedir),
      buildConfigLayer(agentfile, rawContent),
    ]);
    const layerMap: Record<LayerName, LayerData> = {
      identity,
      knowledge,
      tools,
      config,
    };

    const imageConfig = buildImageConfig(agentfile, { createdAt });
    const configContent = `${JSON.stringify(imageConfig, null, 2)}\n`;
    const configBuffer = Buffer.from(configContent, "utf-8");
    const configDigest = `sha256:${crypto.createHash("sha256").update(configBuffer).digest("hex")}`;
    const configDescriptor: OciDescriptor = {
      mediaType: CONFIG_MEDIA_TYPE,
      digest: configDigest,
      size: configBuffer.length,
    };

    const layerDescriptors = LAYER_ORDER.map((name) => ({
      name,
      descriptor: {
        mediaType: LAYER_MEDIA_TYPE,
        digest: layerMap[name].digest,
        size: layerMap[name].size,
      },
    }));

    const manifest = buildOciManifest(agentfile, configDescriptor, layerDescriptors, {
      createdAt,
      resolvedBase: resolvedBase ?? agentfile.base,
    });

    const layerInfos: LayerInfo[] = LAYER_ORDER.map((name) => ({
      name,
      digest: layerMap[name].digest,
      size: layerMap[name].size,
      fileCount: layerMap[name].fileCount,
    }));

    if (options.dryRun) {
      return this.dryRunResult(options.ref, manifest, layerInfos, createdAt);
    }

    const layers = new Map<string, Buffer>();
    for (const name of LAYER_ORDER) {
      layers.set(name, layerMap[name].content);
    }
    const imageData: ImageData = {
      manifest: manifest as unknown as Record<string, unknown>,
      config: imageConfig as unknown as Record<string, unknown>,
      layers,
    };

    const stored: StoredImage = await this.store.save(options.ref, imageData);
    return {
      ref: stored.ref,
      digest: stored.digest,
      size: stored.size,
      layers: layerInfos,
      createdAt: stored.createdAt,
    };
  }

  private dryRunResult(
    ref: string,
    manifest: { config: OciDescriptor },
    layerInfos: LayerInfo[],
    createdAt: string,
  ): BuildResult {
    // dry-run では store 保存しないため digest は config.json のダイジェストで代替する
    return {
      ref,
      digest: manifest.config.digest,
      size: manifest.config.size + layerInfos.reduce((acc, l) => acc + l.size, 0),
      layers: layerInfos,
      createdAt,
    };
  }

  private async parse(agentfilePath: string): Promise<{
    agentfile: Agentfile;
    resolvedBase?: string;
    rawContent: string;
  }> {
    const abs = path.resolve(agentfilePath);
    const basedir = path.dirname(abs);
    const rawContent = await fs.readFile(abs, "utf-8");
    const { agentfile, resolvedBase } = await parseAgentfile(rawContent, { basedir });
    return { agentfile, resolvedBase, rawContent };
  }
}

export type { ImageConfigFile };
