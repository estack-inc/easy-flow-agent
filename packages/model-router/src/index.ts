import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { classifyMessage } from "./classifier.js";
import { DEFAULT_CONFIG, type ModelRouterConfig } from "./config.js";
import { SessionStore } from "./session-store.js";

export default function register(api: OpenClawPluginApi): void {
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
  api.registerHook(["before_model_resolve"], (event: unknown, ctx: unknown) => {
    try {
      const ctxObj = (ctx ?? undefined) as Record<string, unknown> | undefined;

      // 初回のみ ctx のキー一覧をログ出力（診断用）
      if (!ctxLogged && cfg.logging) {
        api.logger.info(`[model-router] ctx shape: ${JSON.stringify(Object.keys(ctxObj ?? {}))}`);
        ctxLogged = true;
      }

      const prompt = (event as { prompt?: string }).prompt ?? "";
      const sessionKey = resolveSessionKey(ctxObj);

      // セッションコンテキスト取得（sessionKey 不明時はセッション追跡をスキップ）
      const sessionContext = sessionStore && sessionKey ? sessionStore.get(sessionKey) : undefined;

      const detail = classifyMessage(prompt, cfg, sessionContext);

      // 分類結果を記録（sessionKey 不明時は記録しない = セッション汚染防止）
      if (sessionStore && sessionKey) {
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
  });

  api.logger.info("[model-router] plugin registered");
}

/**
 * ctx からセッション識別キーを取得。
 * キーが不明な場合は null を返し、呼び出し側でセッション追跡をスキップする。
 * （null フォールバックがないと、異なるユーザー・会話の履歴が混在しセッション汚染を引き起こす）
 */
function resolveSessionKey(ctx: Record<string, unknown> | undefined): string | null {
  if (!ctx) return null;
  if (typeof ctx.sessionKey === "string" && ctx.sessionKey) return ctx.sessionKey;
  if (typeof ctx.sessionId === "string" && ctx.sessionId) return ctx.sessionId;
  return null;
}
