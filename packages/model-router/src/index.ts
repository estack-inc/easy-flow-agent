import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { classifyMessage } from "./classifier.js";
import { DEFAULT_CONFIG, type ModelRouterConfig } from "./config.js";

export default function register(api: OpenClawPluginApi): void {
  const cfg: Required<ModelRouterConfig> = {
    ...DEFAULT_CONFIG,
    ...(api.pluginConfig as ModelRouterConfig),
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      ...((api.pluginConfig as ModelRouterConfig)?.patterns ?? {}),
    },
  };

  // before_model_resolve: プロンプトを分類してモデルをオーバーライド
  api.registerHook(["before_model_resolve"], (event: unknown, _ctx: unknown) => {
    try {
      const prompt = (event as { prompt?: string }).prompt ?? "";
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
