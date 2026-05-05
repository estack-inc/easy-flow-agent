// portal-notify-tool プラグインエントリポイント。
//
// OpenClaw ホストから default export の register(api) が呼ばれる。
// api は OpenClaw plugin SDK の OpenClawPluginApi だが、本パッケージは optional peerDep
// にしているため、build / test が openclaw 未インストール環境でも通るよう
// 構造的型 (PluginApiLike) で必要分だけ宣言する。
//
// 役割：
//   1. pluginConfig + 環境変数から PortalNotifyConfig を解決
//   2. PortalNotifyClient を 1 個だけ作って共有
//   3. notify_send ツールを registerTool で公開
//
// 設計判断：
//   - Pinecone / Auth トークンと違い、portal token は per-instance で 1 個固定。
//     factory でテナントごとに切り替える必要はないので、register() の中で client を
//     1 個生成して全 tool に共有する。
//   - 設定不足（origin / token なし）のときは fatal error にせず warn ログ + 登録スキップ。
//     これにより token がまだセットされていないインスタンスでも plugin ロード自体は失敗しない
//     （workflow-controller / model-router と同じ「未設定なら無効化」パターン）。

import { createPortalNotifyClient } from "./client.js";
import {
  type PortalNotifyConfigInput,
  resolveConfig,
} from "./config.js";
import { createNotifySendTool } from "./tool.js";
import { PortalNotifyConfigError } from "./types.js";

// public API として再 export。caller（テスト・他パッケージ）は client サブパス
// `@openclaw/portal-notify-tool/client` ではなく root から import 可能。
export { createPortalNotifyClient } from "./client.js";
export { DEFAULT_PORTAL_NOTIFY_CONFIG, resolveConfig } from "./config.js";
export { createNotifySendTool } from "./tool.js";
export * from "./types.js";

/**
 * OpenClaw plugin API の最小サブセット（構造的型）。
 * 本パッケージで必要な registerTool / logger / pluginConfig だけ定義する。
 */
interface PluginApiLike {
  pluginConfig?: unknown;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, ...rest: unknown[]) => void;
  };
  registerTool: (
    factory: (ctx: unknown) => unknown,
    options: { names: string[]; optional?: boolean },
  ) => void;
}

const portalNotifyToolPlugin = {
  id: "portal-notify-tool",
  name: "Portal Notify Tool",
  description:
    "Relays agent notifications to the easy.flow portal (LINE / email). Provides notify_send tool.",
  kind: "plugin" as const,

  register(api: PluginApiLike): void {
    const rawConfig = (api.pluginConfig ?? {}) as PortalNotifyConfigInput;

    let cfg;
    try {
      cfg = resolveConfig(rawConfig);
    } catch (err) {
      if (err instanceof PortalNotifyConfigError) {
        // origin / token 欠落は plugin ロード時には fatal にしない。
        // tool 自体を登録しないことで agent 側に「ツール未提供」と伝える。
        api.logger.warn(
          `[portal-notify-tool] disabled: ${err.message}. ` +
            `Set PORTAL_ORIGIN / PORTAL_NOTIFICATION_TOKEN to enable.`,
        );
        return;
      }
      throw err;
    }

    const client = createPortalNotifyClient(cfg);
    const notifyTool = createNotifySendTool(client);

    api.registerTool(
      (ctx) => {
        // ctx.sandboxed 等のホスト判定はキャストして読む（構造的型では未定義）
        const sandboxed = (ctx as { sandboxed?: boolean }).sandboxed;
        if (sandboxed) return null;
        return [notifyTool];
      },
      {
        names: ["notify_send"],
        optional: true,
      },
    );

    api.logger.info(
      `[portal-notify-tool] registered notify_send tool (origin=${cfg.origin})`,
    );
  },
};

export default portalNotifyToolPlugin;
