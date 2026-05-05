import * as fs from "node:fs";

const src = process.argv[2] || "/app/openclaw.json.template";
const dst = process.argv[3] || "/data/openclaw.json";
const PLACEHOLDER_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const EXPANDABLE_PLACEHOLDER_KEYS = new Set([
  "GATEWAY_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LINE_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
]);

// env セクションはユーザー定義値（Agentfile の config.env）を含むため展開対象外とする。
// その他のセクションでも、意図的に生成した secret placeholder だけを展開する。
const NON_EXPANDABLE_TOP_LEVEL_KEYS = new Set(["env"]);

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

const template = JSON.parse(fs.readFileSync(src, "utf8"));
const missingKeys = new Set();
const rendered = Object.fromEntries(
  Object.entries(template).map(([key, value]) => [
    key,
    renderValue(value, missingKeys, !NON_EXPANDABLE_TOP_LEVEL_KEYS.has(key)),
  ]),
);

if (missingKeys.size > 0) {
  console.error(`render-openclaw-config: missing env: ${Array.from(missingKeys).join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(dst, `${JSON.stringify(rendered, null, 2)}\n`);
