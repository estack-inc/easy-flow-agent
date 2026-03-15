import { describe, expect, it } from "vitest";
import {
  agentStateToUnified,
  formatAgentContextForLLM,
  unifiedToAgentState,
  updateAgentContext,
} from "./agent-state-converter.js";
import {
  createMockAgentState,
  createMockUnifiedAgentState,
  createMockWorkflowState,
} from "./test-fixtures.js";
import type { UnifiedAgentState } from "./types.js";
import { toUnifiedAgentState } from "./types.js";
import {
  advanceWorkflowStep,
  blockWorkflowStep,
  getWorkflowSummary,
  workflowStateToUnified,
} from "./workflow-state-converter.js";

// =============================================================================
// Workflow → Unified → Agent ラウンドトリップ
// =============================================================================

describe("Workflow to Agent roundtrip", () => {
  it("converts workflow → unified → agent → unified without data loss", () => {
    const workflow = createMockWorkflowState();
    const unified1 = workflowStateToUnified(workflow);
    const agent = unifiedToAgentState(unified1);
    const unified2 = agentStateToUnified(agent, {
      workflowId: workflow.workflowId,
      currentStepId: workflow.currentStepId,
    });

    expect(unified2.workflowId).toBe(unified1.workflowId);
    expect(unified2.currentStepId).toBe(unified1.currentStepId);
    expect(unified2.completedStepIds).toEqual(unified1.completedStepIds);
    expect(unified2.facts).toEqual(unified1.facts);
    expect(unified2.openQuestions).toEqual(unified1.openQuestions);
    expect(unified2.currentPlan).toBe(unified1.currentPlan);
  });

  it("toUnifiedAgentState and workflowStateToUnified produce equivalent results", () => {
    const workflow = createMockWorkflowState();
    const fromTypes = toUnifiedAgentState(workflow);
    const fromConverter = workflowStateToUnified(workflow);

    expect(fromTypes.workflowId).toBe(fromConverter.workflowId);
    expect(fromTypes.currentStepId).toBe(fromConverter.currentStepId);
    expect(fromTypes.completedStepIds).toEqual(fromConverter.completedStepIds);
    expect(fromTypes.facts).toEqual(fromConverter.facts);
    expect(fromTypes.openQuestions).toEqual(fromConverter.openQuestions);
    expect(fromTypes.currentPlan).toBe(fromConverter.currentPlan);
  });

  it("blockedReasons are lost through Agent layer roundtrip", () => {
    const workflow = createMockWorkflowState({
      steps: [
        { id: "step-1", label: "S1", status: "blocked", blockedReasons: ["reason-A"] },
        { id: "step-2", label: "S2", status: "pending" },
      ],
    });

    const unified1 = workflowStateToUnified(workflow);
    expect(unified1.blockedReasons).toEqual(["reason-A"]);

    const agent = unifiedToAgentState(unified1);
    const unified2 = agentStateToUnified(agent, {
      workflowId: workflow.workflowId,
      currentStepId: workflow.currentStepId,
    });

    // Agent レイヤーを経由すると blockedReasons は喪失する
    expect(unified2.blockedReasons).toEqual([]);
  });
});

// =============================================================================
// 複雑なワークフロー遷移
// =============================================================================

describe("Complex workflow transitions", () => {
  it("handles multiple step advances with context updates", () => {
    let workflow = createMockWorkflowState();

    // step-2 を完了し事実・質問を追加
    workflow = advanceWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-2",
      newFacts: ["New fact from step 2"],
      newQuestions: ["New question from step 2"],
      planUpdate: "Updated plan after step 2",
    });

    const unified = workflowStateToUnified(workflow);
    expect(unified.completedStepIds).toContain("step-1");
    expect(unified.completedStepIds).toContain("step-2");
    expect(unified.facts).toContain("New fact from step 2");
    expect(unified.openQuestions).toContain("New question from step 2");
    expect(unified.currentPlan).toBe("Updated plan after step 2");
    expect(unified.currentStepId).toBe("step-3");
  });

  it("handles advance → block → advance sequence", () => {
    let workflow = createMockWorkflowState();

    // step-2 完了
    workflow = advanceWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-2",
    });
    expect(workflow.currentStepId).toBe("step-3");

    // step-3 ブロック
    workflow = blockWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-3",
      reasons: ["External dependency"],
    });

    const blockedUnified = workflowStateToUnified(workflow);
    expect(blockedUnified.blockedReasons).toEqual(["External dependency"]);

    // step-3 を完了（ブロック解除+完了）
    workflow = advanceWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-3",
    });

    const finalUnified = workflowStateToUnified(workflow);
    expect(finalUnified.completedStepIds).toContain("step-3");
    expect(finalUnified.blockedReasons).toEqual([]);
  });

  it("resolves questions across advance steps", () => {
    let workflow = createMockWorkflowState({
      openQuestions: ["Q-A", "Q-B"],
    });

    // step-2 完了時に Q-A を解決し新質問を追加
    workflow = advanceWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-2",
      resolvedQuestions: ["Q-A"],
      newQuestions: ["Q-C"],
    });

    // step-3 完了時に Q-B を解決
    workflow = advanceWorkflowStep(workflow, {
      workflowId: workflow.workflowId,
      stepId: "step-3",
      resolvedQuestions: ["Q-B"],
    });

    const unified = workflowStateToUnified(workflow);
    expect(unified.openQuestions).toEqual(["Q-C"]);
  });
});

// =============================================================================
// Agent コンテキスト更新 → Unified 変換
// =============================================================================

describe("Agent context updates to unified", () => {
  it("updates agent state and converts to unified", () => {
    let agent = createMockAgentState();

    agent = updateAgentContext(agent, {
      newFacts: ["Discovered fact"],
      newQuestions: ["New question"],
      resolvedQuestions: ["Agent Question 1"],
    });

    const unified = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-3",
    });

    expect(unified.facts).toContain("Discovered fact");
    expect(unified.facts).toContain("Agent Fact 1");
    expect(unified.openQuestions).toEqual(["New question"]);
    expect(unified.openQuestions).not.toContain("Agent Question 1");
  });

  it("accumulates multiple context updates before conversion", () => {
    let agent = createMockAgentState({ facts: [], openQuestions: [] });

    agent = updateAgentContext(agent, { newFacts: ["Fact A"] });
    agent = updateAgentContext(agent, { newFacts: ["Fact B"] });
    agent = updateAgentContext(agent, { newQuestions: ["Q1"] });

    const unified = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-1",
    });

    expect(unified.facts).toEqual(["Fact A", "Fact B"]);
    expect(unified.openQuestions).toEqual(["Q1"]);
  });
});

// =============================================================================
// コンテキスト形式化（Markdown 出力の統合確認）
// =============================================================================

describe("Context formatting", () => {
  it("formats workflow summary with all sections", () => {
    const workflow = createMockWorkflowState();
    const summary = getWorkflowSummary(workflow);

    expect(summary).toContain("## Workflow: Test Workflow");
    expect(summary).toContain("**Progress:** 1/3 steps completed");
    expect(summary).toContain("**Current:** Second Step");
    expect(summary).toContain("**Plan:** Current plan text");
    expect(summary).toContain("**Facts:**");
    expect(summary).toContain("- Fact 1");
    expect(summary).toContain("**Open Questions:**");
    expect(summary).toContain("- Question 1");
  });

  it("formats agent context for LLM", () => {
    const agent = createMockAgentState();
    const markdown = formatAgentContextForLLM(agent);

    expect(markdown).toContain("## Agent Context");
    expect(markdown).toContain("**Plan:** Agent plan");
    expect(markdown).toContain("**Collected Facts:**");
    expect(markdown).toContain("- Agent Fact 1");
    expect(markdown).toContain("**Open Questions:**");
    expect(markdown).toContain("- Agent Question 1");
    expect(markdown).toContain("**Completed Steps:** step-1");
  });

  it("both formatters produce non-empty output for populated state", () => {
    const workflow = createMockWorkflowState();
    const agent = createMockAgentState();

    const wfSummary = getWorkflowSummary(workflow);
    const agentMd = formatAgentContextForLLM(agent);

    expect(wfSummary.length).toBeGreaterThan(0);
    expect(agentMd.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// エッジケース
// =============================================================================

describe("Edge cases", () => {
  it("handles empty workflow with no facts or questions", () => {
    const workflow = createMockWorkflowState({
      facts: [],
      openQuestions: [],
      completedStepIds: [],
    });

    const unified = workflowStateToUnified(workflow);
    expect(unified.facts).toEqual([]);
    expect(unified.openQuestions).toEqual([]);
    expect(unified.completedStepIds).toEqual([]);
  });

  it("handles very long fact and question lists", () => {
    const facts = Array.from({ length: 100 }, (_, i) => `Fact ${i}`);
    const questions = Array.from({ length: 100 }, (_, i) => `Question ${i}`);

    const workflow = createMockWorkflowState({ facts, openQuestions: questions });
    const unified = workflowStateToUnified(workflow);

    expect(unified.facts).toHaveLength(100);
    expect(unified.openQuestions).toHaveLength(100);

    // Agent ラウンドトリップでも保持
    const agent = unifiedToAgentState(unified);
    expect(agent.facts).toHaveLength(100);
    expect(agent.openQuestions).toHaveLength(100);
  });

  it("handles Markdown special characters in facts", () => {
    const specialFacts = [
      "**Bold text** and _italic_",
      "`code snippet`",
      "- List\n- Items",
      "[link](https://example.com)",
      "| table | cell |",
    ];

    const workflow = createMockWorkflowState({ facts: specialFacts });
    const unified = workflowStateToUnified(workflow);
    expect(unified.facts).toEqual(specialFacts);

    // Agent 経由でも保持される
    const agent = unifiedToAgentState(unified);
    const restored = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-1",
    });
    expect(restored.facts).toEqual(specialFacts);
  });

  it("handles empty agent state", () => {
    const agent = createMockAgentState({
      completedSteps: [],
      facts: [],
      openQuestions: [],
      currentPlan: "",
    });

    const unified = agentStateToUnified(agent, {
      workflowId: "wf-empty",
      currentStepId: "step-0",
    });

    expect(unified.completedStepIds).toEqual([]);
    expect(unified.facts).toEqual([]);
    expect(unified.openQuestions).toEqual([]);
    expect(unified.currentPlan).toBe("");
  });
});

// =============================================================================
// 一貫性チェック
// =============================================================================

describe("Consistency checks", () => {
  it("maintains fact order through conversions", () => {
    const facts = ["First", "Second", "Third"];
    const workflow = createMockWorkflowState({ facts });

    const unified1 = workflowStateToUnified(workflow);
    const agent = unifiedToAgentState(unified1);
    const unified2 = agentStateToUnified(agent, {
      workflowId: workflow.workflowId,
      currentStepId: workflow.currentStepId,
    });

    expect(unified2.facts).toEqual(facts);
  });

  it("maintains question order through conversions", () => {
    const questions = ["Why?", "How?", "When?"];
    const workflow = createMockWorkflowState({ openQuestions: questions });

    const unified1 = workflowStateToUnified(workflow);
    const agent = unifiedToAgentState(unified1);
    const unified2 = agentStateToUnified(agent, {
      workflowId: workflow.workflowId,
      currentStepId: workflow.currentStepId,
    });

    expect(unified2.openQuestions).toEqual(questions);
  });

  it("does not mutate original objects during conversion chain", () => {
    const workflow = createMockWorkflowState();
    const originalFacts = [...workflow.facts];
    const originalQuestions = [...workflow.openQuestions];

    const unified = workflowStateToUnified(workflow);
    unified.facts.push("Modified fact");
    unified.openQuestions.push("Modified question");

    const agent = unifiedToAgentState(unified);
    agent.facts.push("Another modification");

    expect(workflow.facts).toEqual(originalFacts);
    expect(workflow.openQuestions).toEqual(originalQuestions);
  });

  it("JSON roundtrip preserves unified state", () => {
    const workflow = createMockWorkflowState();
    const unified = workflowStateToUnified(workflow);

    const json = JSON.stringify(unified);
    const restored: UnifiedAgentState = JSON.parse(json);

    expect(restored).toEqual(unified);
  });
});

// =============================================================================
// 型安全性
// =============================================================================

describe("Type safety", () => {
  it("has all required fields in UnifiedAgentState from workflow", () => {
    const workflow = createMockWorkflowState();
    const unified = workflowStateToUnified(workflow);

    expect(unified).toHaveProperty("workflowId");
    expect(unified).toHaveProperty("currentStepId");
    expect(unified).toHaveProperty("completedStepIds");
    expect(unified).toHaveProperty("blockedReasons");
    expect(unified).toHaveProperty("facts");
    expect(unified).toHaveProperty("openQuestions");
    expect(unified).toHaveProperty("currentPlan");
  });

  it("has all required fields in UnifiedAgentState from agent", () => {
    const agent = createMockAgentState();
    const unified = agentStateToUnified(agent, {
      workflowId: "wf-type",
      currentStepId: "step-1",
    });

    expect(unified).toHaveProperty("workflowId");
    expect(unified).toHaveProperty("currentStepId");
    expect(unified).toHaveProperty("completedStepIds");
    expect(unified).toHaveProperty("blockedReasons");
    expect(unified).toHaveProperty("facts");
    expect(unified).toHaveProperty("openQuestions");
    expect(unified).toHaveProperty("currentPlan");
  });

  it("mock fixtures produce valid structures", () => {
    const unified = createMockUnifiedAgentState();
    expect(typeof unified.workflowId).toBe("string");
    expect(Array.isArray(unified.completedStepIds)).toBe(true);
    expect(Array.isArray(unified.blockedReasons)).toBe(true);
    expect(Array.isArray(unified.facts)).toBe(true);
    expect(Array.isArray(unified.openQuestions)).toBe(true);
  });
});
