import type { Agentfile } from "../agentfile/types.js";
import type {
  ImageConfigFile,
  LayerInfo,
  OciDescriptor,
  OciLayerDescriptor,
  OciManifest,
} from "./types.js";

export const MANIFEST_MEDIA_TYPE = "application/vnd.easyflow.agent.manifest.v1+json" as const;
export const CONFIG_MEDIA_TYPE = "application/vnd.easyflow.agent.config.v1+json";
export const LAYER_MEDIA_TYPE = "application/vnd.easyflow.agent.layer.v1.tar+gzip";

const BUILD_TOOL = "easyflow-cli/0.1.0";

export interface BuildImageConfigOptions {
  createdAt: string;
}

/**
 * config.json (ImageConfigFile) を Agentfile から生成する。
 */
export function buildImageConfig(
  agentfile: Agentfile,
  options: BuildImageConfigOptions,
): ImageConfigFile {
  const channels = enabledChannelNames(agentfile);
  return {
    schemaVersion: 1,
    agentfile: "easyflow/v1",
    metadata: {
      name: agentfile.metadata.name,
      version: agentfile.metadata.version,
      description: agentfile.metadata.description,
      author: agentfile.metadata.author,
      createdAt: options.createdAt,
      buildTool: BUILD_TOOL,
    },
    ...(agentfile.base ? { base: { ref: agentfile.base } } : {}),
    knowledge: {
      totalChunks: 0,
      totalTokens: 0,
      sources: (agentfile.knowledge?.sources ?? []).map((s) => ({
        path: s.path,
        type: s.type,
        description: s.description,
        chunks: 0,
        tokens: 0,
      })),
    },
    tools: agentfile.tools?.builtin ?? [],
    channels,
  };
}

export interface BuildOciManifestOptions {
  createdAt: string;
  /** annotation 用の base 表示（継承解決後の名称等） */
  resolvedBase?: string;
}

/**
 * OCI Image Manifest v2 を組み立てる（アノテーション込み）。
 */
export function buildOciManifest(
  agentfile: Agentfile,
  configDescriptor: OciDescriptor,
  layers: Array<{ name: LayerInfo["name"]; descriptor: OciDescriptor }>,
  options: BuildOciManifestOptions,
): OciManifest {
  const channels = enabledChannelNames(agentfile);

  const annotatedLayers: OciLayerDescriptor[] = layers.map(({ name, descriptor }) => ({
    ...descriptor,
    annotations: { "org.easyflow.layer.name": name },
  }));

  const baseAnnotation = options.resolvedBase ?? agentfile.base;
  const annotations: Record<string, string> = {
    "org.easyflow.version": agentfile.metadata.version,
    "org.easyflow.knowledge.chunks": "0",
    "org.easyflow.knowledge.tokens": "0",
    "org.easyflow.tools": (agentfile.tools?.builtin ?? []).join(","),
    "org.easyflow.channels": channels.join(","),
    "org.opencontainers.image.created": options.createdAt,
    "org.opencontainers.image.authors": agentfile.metadata.author,
  };
  if (baseAnnotation) {
    annotations["org.easyflow.base"] = baseAnnotation;
  }

  return {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: configDescriptor,
    layers: annotatedLayers,
    annotations,
  };
}

/** 有効化されたチャネル名（enabled: true）を返す */
export function enabledChannelNames(agentfile: Agentfile): string[] {
  const result: string[] = [];
  const channels = agentfile.channels;
  if (!channels) return result;
  for (const name of ["slack", "line", "webchat"] as const) {
    const channel = channels[name];
    if (channel?.enabled) result.push(name);
  }
  return result;
}
