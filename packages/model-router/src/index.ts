import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyMessage } from "./classifier.js";
import { DEFAULT_CONFIG, type ModelRouterConfig } from "./config.js";
import { SessionStore } from "./session-store.js";

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description:
    "Routes lightweight messages to Haiku and complex tasks to Sonnet based on rule-based classification",
  register(api) {
    const cfg: Required<ModelRouterConfig> = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as ModelRouterConfig),
      patterns: {
        ...DEFAULT_CONFIG.patterns,
        ...((api.pluginConfig as ModelRouterConfig)?.patterns ?? {}),
      },
    };

    const sessionStore = cfg.enableSessionContext
      ? new SessionStore({
          stickyWindowSize: cfg.stickyWindowSize,
          sessionTtlMs: cfg.sessionTtlMs,
          maxSessions: cfg.maxSessions,
        })
      : null;

    let ctxLogged = false;

    // before_model_resolve: プロンプトを分類してモデルをオーバーライド
    api.registerHook(
      ["before_model_resolve"],
      (event: { prompt?: string }, ctx: Record<string, unknown> | undefined) => {
        try {
          // 初回のみ ctx のキー一覧をログ出力（診断用）
          if (!ctxLogged && cfg.logging) {
            api.logger.info(`[model-router] ctx shape: ${JSON.stringify(Object.keys(ctx ?? {}))}`);
            ctxLogged = true;
          }

          const prompt = event.prompt ?? "";
          const sessionKey = resolveSessionKey(ctx);

          // セッションコンテキスト取得
          const sessionContext = sessionStore ? sessionStore.get(sessionKey) : undefined;

          const detail = classifyMessage(prompt, cfg, sessionContext);

          // 分類結果を記録
          if (sessionStore) {
            sessionStore.record(sessionKey, detail);
          }

          if (detail.result === "light") {
            if (cfg.logging) {
              api.logger.info(
                `[model-router] → ${cfg.lightProvider}/${cfg.lightModel}` +
                  ` (reason: ${detail.reason}, prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}")`,
              );
            }
            return {
              modelOverride: cfg.lightModel,
              providerOverride: cfg.lightProvider,
            };
          }

          if (cfg.logging) {
            api.logger.debug(
              `[model-router] → ${cfg.defaultProvider}/${cfg.defaultModel}` +
                ` (reason: ${detail.reason})`,
            );
          }
          // void return = デフォルトモデル維持
        } catch (err) {
          // 例外時はデフォルトモデルを維持（void return）
          api.logger.warn(`[model-router] classify error: ${err}`);
        }
      },
    );

    api.logger.info("[model-router] plugin registered");
  },
});

/** ctx からセッション識別キーを取得。未定義時は "unknown" にフォールバック */
function resolveSessionKey(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return "unknown";
  if (typeof ctx.sessionKey === "string" && ctx.sessionKey) return ctx.sessionKey;
  if (typeof ctx.sessionId === "string" && ctx.sessionId) return ctx.sessionId;
  return "unknown";
}
