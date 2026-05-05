const fs = require("node:fs");

const src = process.argv[2] || "/app/openclaw.json.template";
const dst = process.argv[3] || "/data/openclaw.json";
const PLACEHOLDER_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

// env セクションはユーザー定義値（Agentfile の config.env）を含むため展開対象外とする。
// その他のセクション（channels, gateway 等）は意図的なプレースホルダを含むため展開する。
const NON_EXPANDABLE_TOP_LEVEL_KEYS = new Set(["env"]);

function renderValue(value, missingKeys, expandable) {
  if (typeof value === "string") {
    if (!expandable) return value;
    return value.replace(PLACEHOLDER_PATTERN, (placeholder, key) => {
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
