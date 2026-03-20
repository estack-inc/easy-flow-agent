/**
 * workflow-controller ビルドスクリプト
 * esbuild でトランスパイル（型チェックなし）+ openclaw.plugin.json コピー
 * 
 * 依存関係: esbuild がルート node_modules に必要
 * 使用法: node build.js
 */
import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "src");
const DIST = join(__dirname, "dist");

// dist/ をクリーン作成
if (existsSync(DIST)) {
  execSync(`rm -rf ${DIST}`);
}
mkdirSync(DIST, { recursive: true });

// esbuild を探す
const esbuildPaths = [
  join(__dirname, "node_modules", ".bin", "esbuild"),
  join(__dirname, "..", "..", "node_modules", ".bin", "esbuild"),
];
const esbuild = esbuildPaths.find(p => existsSync(p));
if (!esbuild) {
  console.error("esbuild not found");
  process.exit(1);
}

// src/ 配下の全 .ts ファイルを再帰的に収集（テスト除外）
function collectFiles(dir, base = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.") && !entry.name.includes("test-fixtures")) {
      results.push(rel);
    }
  }
  return results;
}

const files = collectFiles(SRC);
console.log(`Transpiling ${files.length} files...`);

for (const rel of files) {
  const src = join(SRC, rel);
  const out = join(DIST, rel.replace(/\.ts$/, ".js"));
  const outDir = dirname(out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  execSync(`${esbuild} "${src}" --format=esm --platform=node --target=es2022 --outfile="${out}"`, {
    stdio: "pipe",
  });
}

// openclaw.plugin.json をコピー
cpSync(join(__dirname, "openclaw.plugin.json"), join(DIST, "openclaw.plugin.json"));

console.log("Build complete:", readdirSync(DIST).join(", "));
