const fs = require("node:fs");

const src = process.argv[2] || "/app/openclaw.json.template";
const dst = process.argv[3] || "/data/openclaw.json";

const tpl = fs.readFileSync(src, "utf8");
const missingKeys = [];
const rendered = tpl.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key) => {
  const v = process.env[key];
  if (v == null) {
    missingKeys.push(key);
    return _;
  }
  return v;
});

if (missingKeys.length > 0) {
  console.error(`render-openclaw-config: missing env: ${missingKeys.join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(dst, rendered);
