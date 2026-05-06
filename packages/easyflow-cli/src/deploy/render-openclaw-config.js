import * as fs from "node:fs";

const src = process.argv[2] || "/app/openclaw.json.template";
const dst = process.argv[3] || "/data/openclaw.json";
const PLACEHOLDER_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

// 非 env セクション用: EXPANDABLE_PLACEHOLDER_KEYS に含まれるキーのみ展開する
const EXPANDABLE_PLACEHOLDER_KEYS = new Set([
  "GATEWAY_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LINE_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
]);

// 非 env セクション用レンダリング: EXPANDABLE_PLACEHOLDER_KEYS のみ展開、未設定は fail-fast
function renderValue(value, missingKeys, expandable) {
  if (typeof value === "string") {
    if (!expandable) return value;
    return value.replace(PLACEHOLDER_PATTERN, (placeholder, key) => {
      if (!EXPANDABLE_PLACEHOLDER_KEYS.has(key)) {
        return placeholder;
      }
      const envValue = process.env[key];
      if (envValue == null) {
        missingKeys.add(key);
        return placeholder;
      }
      return envValue;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, missingKeys, expandable));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, renderValue(entryValue, missingKeys, expandable)]),
    );
  }

  return value;
}

// env セクション用レンダリング: 任意の ${KEY} を process.env から展開する
// 未設定のキーは展開せず該当エントリをスキップ（fail-fast しない）
function renderEnvEntry(entryValue) {
  if (typeof entryValue !== "string") return { ok: true, value: entryValue };
  const missing = new Set();
  const rendered = entryValue.replace(PLACEHOLDER_PATTERN, (placeholder, key) => {
    const envValue = process.env[key];
    if (envValue == null) {
      missing.add(key);
      return placeholder;
    }
    return envValue;
  });
  return { ok: missing.size === 0, value: rendered };
}

const template = JSON.parse(fs.readFileSync(src, "utf8"));
const missingKeys = new Set();

const rendered = {};
for (const [key, value] of Object.entries(template)) {
  if (key === "env") {
    // env セクション: 任意 ${KEY} を展開し、未設定エントリはスキップして warn
    const renderedEnv = {};
    for (const [envKey, envValue] of Object.entries(value ?? {})) {
      const result = renderEnvEntry(envValue);
      if (result.ok) {
        renderedEnv[envKey] = result.value;
      } else {
        console.warn(`render-openclaw-config: env.${envKey} not in process.env, skipped`);
      }
    }
    rendered[key] = renderedEnv;
  } else {
    rendered[key] = renderValue(value, missingKeys, true);
  }
}

if (missingKeys.size > 0) {
  console.error(`render-openclaw-config: missing env: ${Array.from(missingKeys).join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(dst, `${JSON.stringify(rendered, null, 2)}\n`);
