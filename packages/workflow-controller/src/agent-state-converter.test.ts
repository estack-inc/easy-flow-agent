import { describe, expect, it } from "vitest";
import type { UnifiedAgentState } from "./types.js";
import type { AgentState } from "./agent-state-converter.js";
import {
  agentStateToUnified,
  unifiedToAgentState,
  updateAgentContext,
  formatAgentContextForLLM,
} from "./agent-state-converter.js";

/** テスト用の AgentState ファクトリ */
function createTestAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    completedSteps: [],
    facts: [],
    currentPlan: "Initial plan",
    openQuestions: [],
    ...overrides,
  };
}

// =============================================================================
// agentStateToUnified
// =============================================================================

describe("agentStateToUnified", () => {
  it("converts AgentState to UnifiedAgentState", () => {
    const agent = createTestAgentState({
      completedSteps: ["step-1"],
      facts: ["fact1", "fact2"],
      openQuestions: ["q1"],
    });

    const unified = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-2",
    });

    expect(unified.workflowId).toBe("wf-001");
    expect(unified.currentStepId).toBe("step-2");
    expect(unified.completedStepIds).toEqual(["step-1"]);
    expect(unified.blockedReasons).toEqual([]);
    expect(unified.facts).toEqual(["fact1", "fact2"]);
    expect(unified.openQuestions).toEqual(["q1"]);
    expect(unified.currentPlan).toBe("Initial plan");
  });

  it("always returns empty blockedReasons", () => {
    const agent = createTestAgentState();
    const unified = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-1",
    });
    expect(unified.blockedReasons).toEqual([]);
  });

  it("creates defensive copies (no shared references)", () => {
    const agent = createTestAgentState({
      completedSteps: ["s1"],
      facts: ["f1"],
      openQuestions: ["q1"],
    });

    const unified = agentStateToUnified(agent, {
      workflowId: "wf-001",
      currentStepId: "step-1",
    });

    unified.completedStepIds.push("mutated");
    unified.facts.push("mutated");
    unified.openQuestions.push("mutated");

    expect(agent.completedSteps).toEqual(["s1"]);
    expect(agent.facts).toEqual(["f1"]);
    expect(agent.openQuestions).toEqual(["q1"]);
  });

  it("handles empty AgentState", () => {
    const agent = createTestAgentState();
    const unified = agentStateToUnified(agent, {
      workflowId: "wf-empty",
      currentStepId: "step-0",
    });

    expect(unified.completedStepIds).toEqual([]);
    expect(unified.facts).toEqual([]);
    expect(unified.openQuestions).toEqual([]);
    expect(unified.currentPlan).toBe("Initial plan");
  });
});

// =============================================================================
// unifiedToAgentState
// =============================================================================

describe("unifiedToAgentState", () => {
  it("converts UnifiedAgentState back to AgentState", () => {
    const unified: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-2",
      completedStepIds: ["step-1"],
      blockedReasons: ["reason"],
      facts: ["fact1"],
      openQuestions: ["q1"],
      currentPlan: "Plan",
    };

    const agent = unifiedToAgentState(unified);

    expect(agent.completedSteps).toEqual(["step-1"]);
    expect(agent.facts).toEqual(["fact1"]);
    expect(agent.openQuestions).toEqual(["q1"]);
    expect(agent.currentPlan).toBe("Plan");
    expect(agent.metadata?.updatedAt).toBeGreaterThan(0);
  });

  it("discards blockedReasons (not part of AgentState)", () => {
    const unified: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-1",
      completedStepIds: [],
      blockedReasons: ["blocked!"],
      facts: [],
      openQuestions: [],
      currentPlan: "",
    };

    const agent = unifiedToAgentState(unified);
    // blockedReasons は AgentState に存在しない
    expect("blockedReasons" in agent).toBe(false);
  });

  it("creates defensive copies (no shared references)", () => {
    const unified: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-1",
      completedStepIds: ["s1"],
      blockedReasons: [],
      facts: ["f1"],
      openQuestions: ["q1"],
      currentPlan: "plan",
    };

    const agent = unifiedToAgentState(unified);

    agent.completedSteps.push("mutated");
    agent.facts.push("mutated");
    agent.openQuestions.push("mutated");

    expect(unified.completedStepIds).toEqual(["s1"]);
    expect(unified.facts).toEqual(["f1"]);
    expect(unified.openQuestions).toEqual(["q1"]);
  });
});

// =============================================================================
// updateAgentContext
// =============================================================================

describe("updateAgentContext", () => {
  it("adds new facts", () => {
    const state = createTestAgentState({ facts: ["existing"] });

    const updated = updateAgentContext(state, {
      newFacts: ["new-fact"],
    });

    expect(updated.facts).toEqual(["existing", "new-fact"]);
  });

  it("adds new questions", () => {
    const state = createTestAgentState({ openQuestions: ["q1"] });

    const updated = updateAgentContext(state, {
      newQuestions: ["q2"],
    });

    expect(updated.openQuestions).toEqual(["q1", "q2"]);
  });

  it("resolves questions", () => {
    const state = createTestAgentState({
      openQuestions: ["q1", "q2", "q3"],
    });

    const updated = updateAgentContext(state, {
      resolvedQuestions: ["q1", "q3"],
    });

    expect(updated.openQuestions).toEqual(["q2"]);
  });

  it("resolves before adding (no accidental removal of new questions)", () => {
    const state = createTestAgentState({
      openQuestions: ["old-q"],
    });

    const updated = updateAgentContext(state, {
      resolvedQuestions: ["old-q"],
      newQuestions: ["new-q"],
    });

    expect(updated.openQuestions).toEqual(["new-q"]);
  });

  it("updates plan when provided", () => {
    const state = createTestAgentState({ currentPlan: "Old plan" });

    const updated = updateAgentContext(state, {
      planUpdate: "New plan",
    });

    expect(updated.currentPlan).toBe("New plan");
  });

  it("preserves plan when planUpdate is not provided", () => {
    const state = createTestAgentState({ currentPlan: "Keep this" });

    const updated = updateAgentContext(state, {
      newFacts: ["fact"],
    });

    expect(updated.currentPlan).toBe("Keep this");
  });

  it("is immutable — does not modify original state", () => {
    const state = createTestAgentState({
      facts: ["original"],
      openQuestions: ["q-original"],
      completedSteps: ["s1"],
    });

    const updated = updateAgentContext(state, {
      newFacts: ["added"],
      newQuestions: ["q-added"],
    });

    expect(state.facts).toEqual(["original"]);
    expect(state.openQuestions).toEqual(["q-original"]);
    expect(state.completedSteps).toEqual(["s1"]);
    expect(updated.facts).toEqual(["original", "added"]);
    expect(updated.openQuestions).toEqual(["q-original", "q-added"]);
  });

  it("updates metadata.updatedAt", () => {
    const state = createTestAgentState({
      metadata: { updatedAt: 1000 },
    });

    const updated = updateAgentContext(state, { newFacts: ["f"] });

    expect(updated.metadata?.updatedAt).toBeGreaterThan(1000);
  });

  it("preserves existing metadata fields", () => {
    const state = createTestAgentState({
      metadata: { createdAt: 500, sessionId: "sess-1", updatedAt: 1000 },
    });

    const updated = updateAgentContext(state, { newFacts: ["f"] });

    expect(updated.metadata?.createdAt).toBe(500);
    expect(updated.metadata?.sessionId).toBe("sess-1");
  });
});

// =============================================================================
// formatAgentContextForLLM
// =============================================================================

describe("formatAgentContextForLLM", () => {
  it("generates Markdown with all sections", () => {
    const state = createTestAgentState({
      currentPlan: "Do the thing",
      facts: ["Fact A", "Fact B"],
      openQuestions: ["Why?", "How?"],
      completedSteps: ["step-1", "step-2"],
    });

    const md = formatAgentContextForLLM(state);

    expect(md).toContain("## Agent Context");
    expect(md).toContain("**Plan:** Do the thing");
    expect(md).toContain("**Collected Facts:**");
    expect(md).toContain("- Fact A");
    expect(md).toContain("- Fact B");
    expect(md).toContain("**Open Questions:**");
    expect(md).toContain("- Why?");
    expect(md).toContain("- How?");
    expect(md).toContain("**Completed Steps:** step-1, step-2");
  });

  it("omits sections when empty", () => {
    const state = createTestAgentState({
      currentPlan: "",
      facts: [],
      openQuestions: [],
      completedSteps: [],
    });

    const md = formatAgentContextForLLM(state);

    expect(md).toContain("## Agent Context");
    expect(md).not.toContain("**Plan:**");
    expect(md).not.toContain("**Collected Facts:**");
    expect(md).not.toContain("**Open Questions:**");
    expect(md).not.toContain("**Completed Steps:**");
  });

  it("includes only plan when other fields are empty", () => {
    const state = createTestAgentState({
      currentPlan: "Solo plan",
    });

    const md = formatAgentContextForLLM(state);

    expect(md).toContain("**Plan:** Solo plan");
    expect(md).not.toContain("**Collected Facts:**");
  });
});

// =============================================================================
// 往復変換（roundtrip）
// =============================================================================

describe("roundtrip conversion", () => {
  it("preserves data through AgentState → Unified → AgentState", () => {
    const original = createTestAgentState({
      completedSteps: ["step-1", "step-2"],
      facts: ["fact1", "fact2"],
      openQuestions: ["q1"],
      currentPlan: "Roundtrip plan",
    });

    const unified = agentStateToUnified(original, {
      workflowId: "wf-rt",
      currentStepId: "step-3",
    });
    const restored = unifiedToAgentState(unified);

    expect(restored.completedSteps).toEqual(original.completedSteps);
    expect(restored.facts).toEqual(original.facts);
    expect(restored.openQuestions).toEqual(original.openQuestions);
    expect(restored.currentPlan).toBe(original.currentPlan);
  });

  it("preserves data through Unified → AgentState → Unified", () => {
    const original: UnifiedAgentState = {
      workflowId: "wf-rt",
      currentStepId: "step-3",
      completedStepIds: ["step-1", "step-2"],
      blockedReasons: [],
      facts: ["fact1"],
      openQuestions: ["q1", "q2"],
      currentPlan: "Roundtrip plan",
    };

    const agent = unifiedToAgentState(original);
    const restored = agentStateToUnified(agent, {
      workflowId: original.workflowId,
      currentStepId: original.currentStepId,
    });

    expect(restored).toEqual(original);
  });

  it("roundtrip discards blockedReasons (lossy for Agent layer)", () => {
    const original: UnifiedAgentState = {
      workflowId: "wf-lossy",
      currentStepId: "step-1",
      completedStepIds: [],
      blockedReasons: ["will be lost"],
      facts: [],
      openQuestions: [],
      currentPlan: "",
    };

    const agent = unifiedToAgentState(original);
    const restored = agentStateToUnified(agent, {
      workflowId: original.workflowId,
      currentStepId: original.currentStepId,
    });

    // blockedReasons は Agent レイヤーを経由すると失われる
    expect(restored.blockedReasons).toEqual([]);
  });
});
