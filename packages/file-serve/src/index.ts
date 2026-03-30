import { createCleanupService } from "./cleanup-service.js";
import { loadConfig } from "./config.js";
import { createBeforeToolCallHook } from "./hook-before-tool-call.js";
import { createHttpHandler } from "./http-handler.js";

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/** OpenClaw プラグイン API の最小インターフェース定義 */
type PluginApi = {
  pluginConfig: unknown;
  /** OpenClaw がホスト設定（publicUrl 等）を公開する場合に利用 */
  config?: Record<string, unknown>;
  logger: PluginLogger;
  registerHook: (event: string, handler: unknown) => void;
  registerHttpRoute: (opts: {
    path: string;
    match: string;
    auth: string;
    handler: unknown;
  }) => void;
  registerService: (service: unknown) => void;
};

const fileServePlugin = {
  id: "file-serve",
  name: "File Serve",
  description:
    "LINE チャネル向けファイル配信プラグイン。エージェント生成ファイルに 7 日間有効な配信 URL を発行する。",

  register(api: PluginApi) {
    const config = loadConfig(api.pluginConfig as Record<string, unknown> | undefined, api.config);

    // 1. HTTP ルート: GET /files/:uuid/:filename
    api.registerHttpRoute({
      path: "/files",
      match: "prefix",
      auth: "plugin",
      handler: createHttpHandler(config, api.logger),
    });

    // 2. before_tool_call フック
    api.registerHook("before_tool_call", createBeforeToolCallHook(config, api.logger));

    // 3. クリーンアップサービス
    api.registerService(createCleanupService(config, api.logger));

    api.logger.info("file-serve プラグイン登録完了");
  },
};

export default fileServePlugin;
