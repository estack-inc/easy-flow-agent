import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type AttachmentHint, classifyMessage, routeByAttachments } from "./classifier.js";
import { DEFAULT_CONFIG, DEFAULT_FILE_ROUTING_RULES, type ModelRouterConfig } from "./config.js";

export default function register(api: OpenClawPluginApi): void {
  const rawConfig = api.pluginConfig as ModelRouterConfig;
  const cfg: Required<ModelRouterConfig> = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      ...(rawConfig?.patterns ?? {}),
    },
    fileRouting: {
      enabled: rawConfig?.fileRouting?.enabled ?? DEFAULT_CONFIG.fileRouting.enabled,
      rules: rawConfig?.fileRouting?.rules ?? DEFAULT_FILE_ROUTING_RULES,
    },
  };

  // before_model_resolve: プロンプトと添付ファイルを分析してモデルをオーバーライド
  api.registerHook(["before_model_resolve"], (event: unknown, _ctx: unknown) => {
    try {
      const e = event as { prompt?: string; attachments?: AttachmentHint[] };
      const prompt = e.prompt ?? "";
      const attachments = e.attachments ?? [];

      // 1. ファイルルーティング（最優先）
      if (cfg.fileRouting.enabled && attachments.length > 0) {
        const fileRoute = routeByAttachments(attachments, cfg.fileRouting.rules ?? []);
        if (fileRoute) {
          if (cfg.logging) {
            api.logger.info(
              `[model-router] → ${fileRoute.provider}/${fileRoute.model}` +
                ` (file: ${fileRoute.matchedRule}, prompt: "${prompt.slice(0, 40)}${prompt.length > 40 ? "..." : ""}")`,
            );
          }
          return {
            modelOverride: fileRoute.model,
            providerOverride: fileRoute.provider,
          };
        }
      }

      // 2. テキストベースのルーティング
      const result = classifyMessage(prompt, cfg);

      if (result === "light") {
        if (cfg.logging) {
          api.logger.info(
            `[model-router] → ${cfg.lightProvider}/${cfg.lightModel}` +
              ` (prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}")`,
          );
        }
        return {
          modelOverride: cfg.lightModel,
          providerOverride: cfg.lightProvider,
        };
      }

      if (cfg.logging) {
        api.logger.debug(`[model-router] → ${cfg.defaultProvider}/${cfg.defaultModel} (default)`);
      }
      // void return = デフォルトモデル維持
    } catch (err) {
      // 例外時はデフォルトモデルを維持（void return）
      api.logger.warn(`[model-router] classify error: ${err}`);
    }
  });

  api.logger.info("[model-router] plugin registered");
}
