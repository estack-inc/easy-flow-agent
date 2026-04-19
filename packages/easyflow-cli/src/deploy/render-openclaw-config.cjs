const fs = require("node:fs");

const src = process.argv[2] || "/app/openclaw.json.template";
const dst = process.argv[3] || "/data/openclaw.json";

const tpl = fs.readFileSync(src, "utf8");
const rendered = tpl.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key) => {
  const v = process.env[key];
  if (v == null) {
    console.error(`render-openclaw-config: env ${key} not set`);
    return "";
  }
  return v;
});
fs.writeFileSync(dst, rendered);
