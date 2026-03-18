import { describe, expect, it } from "vitest";
import { validatorPrompts } from "./index.js";

describe("validatorPrompts", () => {
  it("全プロンプトが空文字でない", () => {
    expect(validatorPrompts.requirements.length).toBeGreaterThan(0);
    expect(validatorPrompts.design.length).toBeGreaterThan(0);
    expect(validatorPrompts.task.length).toBeGreaterThan(0);
    expect(validatorPrompts.outputReview.length).toBeGreaterThan(0);
  });

  it("各プロンプトがシステムプロンプトのヘッダーを含む", () => {
    expect(validatorPrompts.requirements).toContain("# requirements-validator システムプロンプト");
    expect(validatorPrompts.design).toContain("# design-validator システムプロンプト");
    expect(validatorPrompts.task).toContain("# task-validator システムプロンプト");
    expect(validatorPrompts.outputReview).toContain("# output-reviewer システムプロンプト");
  });
});
