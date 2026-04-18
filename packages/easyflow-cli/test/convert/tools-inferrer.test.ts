import { describe, expect, it } from "vitest";
import { inferTools } from "../../src/convert/tools-inferrer.js";
import type { TemplateSnapshot } from "../../src/convert/types.js";

function makeSnapshot(partial: Partial<TemplateSnapshot> = {}): TemplateSnapshot {
  return {
    rootDir: "/tmp/test-template",
    hasWorkspaceDir: false,
    ...partial,
  };
}

describe("inferTools", () => {
  it("デフォルトでは workflow-controller のみ返る", () => {
    const result = inferTools(makeSnapshot(), { templateName: "monitor" });

    expect(result.builtin).toEqual(["workflow-controller"]);
    expect(result.warnings).toEqual([]);
  });

  it("hasWorkspaceDir=true のとき file-serve が追加される", () => {
    const result = inferTools(makeSnapshot({ hasWorkspaceDir: true }), {
      templateName: "executive-assistant",
    });

    expect(result.builtin).toEqual(["workflow-controller", "file-serve"]);
    expect(result.warnings).toEqual([]);
  });

  it("entrypoint.sh の本文に識別子が出現すれば追加される", () => {
    const entrypointSh = "#!/bin/bash\n# uses model-router and file-serve\n";
    const result = inferTools(makeSnapshot({ entrypointSh }), { templateName: "monitor" });

    expect(result.builtin).toEqual(["workflow-controller", "file-serve", "model-router"]);
    expect(result.warnings).toEqual([]);
  });

  it("TOOLS.md の本文に識別子が出現すれば追加される（重複は排除）", () => {
    const toolsMd = "- workflow-controller\n- model-router\n";
    const result = inferTools(makeSnapshot({ toolsMd }), { templateName: "monitor" });

    expect(result.builtin).toEqual(["workflow-controller", "model-router"]);
    expect(result.warnings).toEqual([]);
  });

  it("pinecone-memory など未サポートツールは無視される", () => {
    const entrypointSh = "uses pinecone-memory, langchain\n";
    const result = inferTools(makeSnapshot({ entrypointSh }), { templateName: "monitor" });

    expect(result.builtin).toEqual(["workflow-controller"]);
    expect(result.warnings).toEqual([]);
  });

  it("未知のテンプレート名でデフォルト適用時は warnings に記録される", () => {
    const result = inferTools(makeSnapshot(), { templateName: "unknown-template" });

    expect(result.builtin).toEqual(["workflow-controller"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("手動で tools.builtin");
  });

  it("既知テンプレート名でも識別子検出があれば warnings は空", () => {
    const result = inferTools(makeSnapshot({ hasWorkspaceDir: true }), {
      templateName: "executive-assistant",
    });

    expect(result.warnings).toEqual([]);
  });
});
