import { describe, expect, it } from "vitest";
import { validateFlowDefinition } from "./flow-schema.js";

// 最小構成の有効なフロー
const minimalFlow = {
  flowId: "my_flow",
  trigger: "📋",
  label: "テストフロー",
  steps: [{ id: "step1", label: "ステップ1" }],
};

describe("validateFlowDefinition", () => {
  // ===========================================================================
  // 正常系
  // ===========================================================================
  describe("正常系", () => {
    it("最小構成が valid", () => {
      const result = validateFlowDefinition(minimalFlow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("全フィールド指定が valid", () => {
      const result = validateFlowDefinition({
        version: 1,
        flowId: "full_flow",
        trigger: "📢",
        label: "全フィールド",
        description: "説明文",
        steps: [
          {
            id: "s1",
            label: "S1",
            conditions: [{ label: "条件A", nextStepId: "s2" }],
          },
          {
            id: "s2",
            label: "S2",
            nextStepId: "s1",
          },
        ],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("自己参照 nextStepId（リトライパターン）が valid", () => {
      const result = validateFlowDefinition({
        flowId: "retry_flow",
        trigger: "🔄",
        label: "リトライフロー",
        steps: [{ id: "retry", label: "リトライ", nextStepId: "retry" }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // V9: 必須フィールド欠落
  // ===========================================================================
  describe("V9: 必須フィールド欠落", () => {
    it("flowId が欠落している場合 invalid", () => {
      const { flowId: _omit, ...data } = minimalFlow;
      const result = validateFlowDefinition(data);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("flowId"))).toBe(true);
    });

    it("trigger が欠落している場合 invalid", () => {
      const { trigger: _omit, ...data } = minimalFlow;
      const result = validateFlowDefinition(data);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("trigger"))).toBe(true);
    });

    it("label が欠落している場合 invalid", () => {
      const { label: _omit, ...data } = minimalFlow;
      const result = validateFlowDefinition(data);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("label"))).toBe(true);
    });

    it("steps が欠落している場合 invalid", () => {
      const { steps: _omit, ...data } = minimalFlow;
      const result = validateFlowDefinition(data);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("steps"))).toBe(true);
    });
  });

  // ===========================================================================
  // V13: version バリデーション
  // ===========================================================================
  describe("V13: version バリデーション", () => {
    it("version: 1 は valid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, version: 1 });
      expect(result.valid).toBe(true);
    });

    it("version 省略は valid", () => {
      const result = validateFlowDefinition(minimalFlow);
      expect(result.valid).toBe(true);
    });

    it("version: 2 は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, version: 2 });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });

    it("version: 0 は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, version: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });

    it("version: 1.5 は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, version: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });
  });

  // ===========================================================================
  // V10: flowId snake_case
  // ===========================================================================
  describe("V10: flowId snake_case バリデーション", () => {
    it("'MyFlow' は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, flowId: "MyFlow" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("flowId"))).toBe(true);
    });

    it("'my-flow' は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, flowId: "my-flow" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("flowId"))).toBe(true);
    });

    it("空文字列は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, flowId: "" });
      expect(result.valid).toBe(false);
    });

    it("'1flow' は invalid（数字始まり）", () => {
      const result = validateFlowDefinition({ ...minimalFlow, flowId: "1flow" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("flowId"))).toBe(true);
    });
  });

  // ===========================================================================
  // V12: 空文字列チェック
  // ===========================================================================
  describe("V12: 空文字列チェック", () => {
    it("trigger が空文字列は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, trigger: "" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("trigger"))).toBe(true);
    });

    it("label が空文字列は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, label: "" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("label"))).toBe(true);
    });

    it("steps[].label が空文字列は invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [{ id: "step1", label: "" }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("label"))).toBe(true);
    });

    it("conditions[].label が空文字列は invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [
          {
            id: "step1",
            label: "ステップ1",
            conditions: [{ label: "", nextStepId: "step1" }],
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("label"))).toBe(true);
    });
  });

  // ===========================================================================
  // V3: steps が空配列
  // ===========================================================================
  describe("V3: steps が空配列", () => {
    it("steps が空配列は invalid", () => {
      const result = validateFlowDefinition({ ...minimalFlow, steps: [] });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("steps"))).toBe(true);
    });
  });

  // ===========================================================================
  // V4: step.id snake_case
  // ===========================================================================
  describe("V4: step.id snake_case バリデーション", () => {
    it("step.id が snake_case でない場合 invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [{ id: "MyStep", label: "ステップ" }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("MyStep"))).toBe(true);
    });
  });

  // ===========================================================================
  // V5: step.id 重複
  // ===========================================================================
  describe("V5: step.id 重複チェック", () => {
    it("step.id が重複している場合 invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [
          { id: "step1", label: "ステップ1" },
          { id: "step1", label: "ステップ2" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("step1") && e.includes("重複"))).toBe(true);
    });
  });

  // ===========================================================================
  // V6: conditions[].nextStepId が存在しない id を参照
  // ===========================================================================
  describe("V6: conditions[].nextStepId の参照チェック", () => {
    it("conditions[].nextStepId が存在しない id を参照している場合 invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [
          {
            id: "step1",
            label: "ステップ1",
            conditions: [{ label: "条件", nextStepId: "nonexistent" }],
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
    });
  });

  // ===========================================================================
  // V7: nextStepId が存在しない id を参照
  // ===========================================================================
  describe("V7: nextStepId の参照チェック", () => {
    it("nextStepId が存在しない id を参照している場合 invalid", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [{ id: "step1", label: "ステップ1", nextStepId: "nonexistent" }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
    });
  });

  // ===========================================================================
  // V11: 未知プロパティ → warning
  // ===========================================================================
  describe("V11: 未知プロパティ検出", () => {
    it("未知のトップレベルプロパティがある場合 valid: true だが warnings に含まれる", () => {
      const result = validateFlowDefinition({ ...minimalFlow, unknownProp: "value" });
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("unknownProp"))).toBe(true);
    });

    it("未知の step プロパティがある場合 valid: true だが warnings に含まれる", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [{ id: "step1", label: "ステップ1", unknownKey: true }],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("unknownKey"))).toBe(true);
    });
  });

  // ===========================================================================
  // 境界値
  // ===========================================================================
  describe("境界値", () => {
    it("conditions が空配列 [] → valid: true", () => {
      const result = validateFlowDefinition({
        ...minimalFlow,
        steps: [{ id: "step1", label: "ステップ1", conditions: [] }],
      });
      expect(result.valid).toBe(true);
    });

    it("step 数 1（最小）→ valid: true", () => {
      const result = validateFlowDefinition(minimalFlow);
      expect(result.valid).toBe(true);
    });

    it("version: 1 → valid: true", () => {
      const result = validateFlowDefinition({ ...minimalFlow, version: 1 });
      expect(result.valid).toBe(true);
    });

    it("version 省略 → valid: true", () => {
      const result = validateFlowDefinition(minimalFlow);
      expect(result.valid).toBe(true);
    });
  });
});
