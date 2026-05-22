import { describe, expect, it, vi } from "vitest";

import fileServePlugin from "../src/index.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("fileServePlugin", () => {
  it("before_tool_call hook を名前付きで登録する", () => {
    const api = {
      pluginConfig: { baseUrl: "https://example.fly.dev" },
      logger: mockLogger,
      registerHttpRoute: vi.fn(),
      registerHook: vi.fn(),
      registerService: vi.fn(),
    };

    fileServePlugin.register(api);

    expect(api.registerHook).toHaveBeenCalledWith("before_tool_call", expect.any(Function), {
      name: "file-serve:before_tool_call",
    });
  });
});
