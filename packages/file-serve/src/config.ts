export type FileServeConfig = {
  storageDir: string;
  baseUrl: string;
  ttlDays: number;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  /** ソースファイルの許可ディレクトリ。設定時はこのディレクトリ外のファイルを拒否する。 */
  allowedSourceDir?: string;
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

  const rawTtlDays = pluginConfig?.ttlDays;
  const ttlDays =
    typeof rawTtlDays === "number" && rawTtlDays > 0 && rawTtlDays <= 3650 ? rawTtlDays : 7;

  const rawWindowMs = (pluginConfig?.rateLimit as { windowMs?: number } | undefined)?.windowMs;
  const windowMs = typeof rawWindowMs === "number" && rawWindowMs >= 1000 ? rawWindowMs : 60000;

  const rawMaxRequests = (pluginConfig?.rateLimit as { maxRequests?: number } | undefined)
    ?.maxRequests;
  const maxRequests =
    typeof rawMaxRequests === "number" && rawMaxRequests >= 1 && rawMaxRequests <= 10000
      ? rawMaxRequests
      : 30;

  const rawAllowedSourceDir = pluginConfig?.allowedSourceDir;
  const allowedSourceDir =
    typeof rawAllowedSourceDir === "string" && rawAllowedSourceDir
      ? rawAllowedSourceDir
      : undefined;

  return {
    storageDir: (pluginConfig?.storageDir as string) ?? "/data/file-serve",
    baseUrl,
    ttlDays,
    rateLimit: { windowMs, maxRequests },
    allowedSourceDir,
  };
}
