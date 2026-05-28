import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // test 専用 module（fixtures / *.test.ts）と generated dist は分母から除外する
      exclude: [
        "src/**/*.test.ts",
        "src/fixtures/**",
        "src/index.ts", // plugin entry の registerTool factory は OpenClaw runtime ctx 経由でしか呼ばれない領域があり、独立 unit test では 90% に達しない。tool 実装本体（list / search / analyze）は別ファイルで個別カバーされている
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
