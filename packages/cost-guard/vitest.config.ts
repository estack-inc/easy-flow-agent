import { defineConfig } from "vitest/config";

// 組み立て済み出力（cost-guard/ 配下の .js）は生成物のため網羅率の計測対象外とし、
// ソース（src/）のみを計測する。生成物をコミットしている都合上、明示的に範囲を絞る。
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
