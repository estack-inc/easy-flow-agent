export type FileServeConfig = {
  storageDir: string;
  baseUrl: string;
  ttlDays: number;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
};

/**
 * プラグイン設定をロードする。
 * baseUrl 優先順位:
 *   1. pluginConfig.baseUrl（明示指定）
 *   2. apiConfig から取得できる publicUrl
 *   3. 環境変数 FLY_APP_NAME から構成
 *   4. フォールバック: "http://localhost:8080"
 */
export function loadConfig(
  pluginConfig: Record<string, unknown> | undefined,
  apiConfig: Record<string, unknown> | undefined,
): FileServeConfig {
  let baseUrl: string;
  if (typeof pluginConfig?.baseUrl === "string" && pluginConfig.baseUrl) {
    baseUrl = pluginConfig.baseUrl;
  } else if (typeof apiConfig?.publicUrl === "string" && apiConfig.publicUrl) {
    baseUrl = apiConfig.publicUrl;
  } else if (process.env.FLY_APP_NAME) {
    baseUrl = `https://${process.env.FLY_APP_NAME}.fly.dev`;
  } else {
    baseUrl = "http://localhost:8080";
  }

  baseUrl = baseUrl.replace(/\/$/, "");

  return {
    storageDir: (pluginConfig?.storageDir as string) ?? "/data/file-serve",
    baseUrl,
    ttlDays: (pluginConfig?.ttlDays as number) ?? 7,
    rateLimit: {
      windowMs: (pluginConfig?.rateLimit as { windowMs?: number })?.windowMs ?? 60000,
      maxRequests: (pluginConfig?.rateLimit as { maxRequests?: number })?.maxRequests ?? 30,
    },
  };
}
