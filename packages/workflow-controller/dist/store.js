import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
function resolveWorkflowDir(agentDir) {
  return path.join(agentDir, "workflow");
}
function resolveWorkflowPath(agentDir, workflowId) {
  return path.join(resolveWorkflowDir(agentDir), `${workflowId}.json`);
}
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 448 });
  }
}
function loadWorkflow(agentDir, workflowId) {
  const filePath = resolveWorkflowPath(agentDir, workflowId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveWorkflow(agentDir, state) {
  const dir = resolveWorkflowDir(agentDir);
  ensureDir(dir);
  const filePath = resolveWorkflowPath(agentDir, state.workflowId);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 384 });
  fs.renameSync(tmpPath, filePath);
}
function listWorkflows(agentDir) {
  const dir = resolveWorkflowDir(agentDir);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
function findWorkflowByIssue(agentDir, issueNumber, issueRepo) {
  const ids = listWorkflows(agentDir);
  for (const id of ids) {
    const state = loadWorkflow(agentDir, id);
    if (!state) continue;
    if (state.issueNumber !== issueNumber) continue;
    if (issueRepo && state.issueRepo !== issueRepo) continue;
    return state;
  }
  return null;
}
function closeWorkflow(agentDir, workflowId) {
  const state = loadWorkflow(agentDir, workflowId);
  if (!state) return null;
  const updated = {
    ...state,
    closedAt: Date.now(),
    updatedAt: Date.now()
  };
  saveWorkflow(agentDir, updated);
  return updated;
}
function createWorkflow(agentDir, params) {
  const now = Date.now();
  const workflowId = crypto.randomUUID();
  const firstStepId = params.steps[0]?.id;
  if (!firstStepId) {
    throw new Error("Workflow must have at least one step");
  }
  const state = {
    workflowId,
    label: params.label,
    currentStepId: firstStepId,
    steps: params.steps.map((s, i) => ({
      id: s.id,
      label: s.label,
      status: i === 0 ? "running" : "pending",
      ...s.nextStepId ? { nextStepId: s.nextStepId } : {},
      ...s.conditions?.length ? { conditions: s.conditions } : {}
    })),
    completedStepIds: [],
    facts: [],
    openQuestions: [],
    currentPlan: params.plan ?? "",
    createdAt: now,
    updatedAt: now,
    sessionId: params.sessionId,
    issueNumber: params.issueNumber,
    issueRepo: params.issueRepo
  };
  saveWorkflow(agentDir, state);
  return state;
}
function resolveNextStepId(step, conditionLabel) {
  if (conditionLabel && step.conditions && step.conditions.length > 0) {
    const matched = step.conditions.find((c) => c.label === conditionLabel);
    if (matched) {
      return matched.nextStepId;
    }
  }
  if (step.nextStepId) {
    return step.nextStepId;
  }
  return null;
}
function advanceStep(agentDir, params) {
  const state = loadWorkflow(agentDir, params.workflowId);
  if (!state) {
    throw new Error(`Workflow not found: ${params.workflowId}`);
  }
  const targetStepId = params.stepId ?? state.currentStepId;
  const stepIndex = state.steps.findIndex((s) => s.id === targetStepId);
  if (stepIndex === -1) {
    throw new Error(`Step not found: ${targetStepId}`);
  }
  const step = state.steps[stepIndex];
  step.status = "completed";
  step.completedAt = Date.now();
  step.blockedReasons = void 0;
  if (!state.completedStepIds.includes(targetStepId)) {
    state.completedStepIds.push(targetStepId);
  }
  const nextStepId = resolveNextStepId(step, params.conditionLabel);
  if (nextStepId) {
    const nextStep = state.steps.find((s) => s.id === nextStepId);
    if (!nextStep) {
      throw new Error(`Branch target step not found: ${nextStepId}`);
    }
    nextStep.status = "running";
    state.currentStepId = nextStep.id;
  } else {
    const nextStep = state.steps.find((s) => s.status === "pending");
    if (nextStep) {
      nextStep.status = "running";
      state.currentStepId = nextStep.id;
    }
  }
  if (params.newFacts) {
    state.facts.push(...params.newFacts);
  }
  if (params.resolvedQuestions) {
    const resolved = new Set(params.resolvedQuestions);
    state.openQuestions = state.openQuestions.filter((q) => !resolved.has(q));
  }
  if (params.newQuestions) {
    state.openQuestions.push(...params.newQuestions);
  }
  if (params.planUpdate) {
    state.currentPlan = params.planUpdate;
  }
  state.updatedAt = Date.now();
  saveWorkflow(agentDir, state);
  return state;
}
function blockStep(agentDir, params) {
  const state = loadWorkflow(agentDir, params.workflowId);
  if (!state) {
    throw new Error(`Workflow not found: ${params.workflowId}`);
  }
  const targetStepId = params.stepId ?? state.currentStepId;
  const step = state.steps.find((s) => s.id === targetStepId);
  if (!step) {
    throw new Error(`Step not found: ${targetStepId}`);
  }
  step.status = "blocked";
  step.blockedReasons = params.reasons;
  state.updatedAt = Date.now();
  saveWorkflow(agentDir, state);
  return state;
}
function buildContextSummary(state) {
  const completed = state.steps.filter((s) => s.status === "completed").length;
  const total = state.steps.length;
  const currentStep = state.steps.find((s) => s.id === state.currentStepId);
  const blockedStep = state.steps.find((s) => s.status === "blocked");
  return {
    workflowId: state.workflowId,
    label: state.label,
    currentStep: currentStep ? `${currentStep.label} (${currentStep.id})` : "(none)",
    progress: `${completed}/${total} steps completed`,
    plan: state.currentPlan,
    facts: state.facts,
    openQuestions: state.openQuestions,
    blockedReasons: blockedStep?.blockedReasons ?? []
  };
}
function renderContextMarkdown(state) {
  const summary = buildContextSummary(state);
  const sections = [];
  sections.push(`## Workflow: ${summary.label}`);
  sections.push(`**Progress:** ${summary.progress}`);
  sections.push(`**Current Step:** ${summary.currentStep}`);
  if (summary.blockedReasons.length > 0) {
    sections.push(`
**Blocked:**
${summary.blockedReasons.map((r) => `- ${r}`).join("\n")}`);
  }
  if (summary.plan) {
    sections.push(`
### Plan
${summary.plan}`);
  }
  if (summary.facts.length > 0) {
    sections.push(`
### Known Facts
${summary.facts.map((f) => `- ${f}`).join("\n")}`);
  }
  if (summary.openQuestions.length > 0) {
    sections.push(`
### Open Questions
${summary.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  const stepLines = state.steps.map((s) => {
    const icon = s.status === "completed" ? "[x]" : s.status === "running" ? "[>]" : s.status === "blocked" ? "[!]" : "[ ]";
    return `- ${icon} ${s.label}`;
  });
  sections.push(`
### Steps
${stepLines.join("\n")}`);
  return sections.join("\n");
}
export {
  advanceStep,
  blockStep,
  buildContextSummary,
  closeWorkflow,
  createWorkflow,
  findWorkflowByIssue,
  listWorkflows,
  loadWorkflow,
  renderContextMarkdown,
  saveWorkflow
};
