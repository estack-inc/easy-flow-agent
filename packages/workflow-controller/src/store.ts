import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  WorkflowState,
  CreateWorkflowParams,
  AdvanceStepParams,
  BlockStepParams,
  WorkflowContextSummary,
} from "./types.js";

/**
 * ワークフロー状態の永続化ストア
 *
 * 保存先: ~/.openclaw/agents/<agentId>/workflow/<workflowId>.json
 * OpenClaw の SessionEntry とは分離し、プラグイン独自のファイルで管理する。
 */

function resolveWorkflowDir(agentDir: string): string {
  return path.join(agentDir, "workflow");
}

function resolveWorkflowPath(agentDir: string, workflowId: string): string {
  return path.join(resolveWorkflowDir(agentDir), `${workflowId}.json`);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

/** ワークフロー状態をディスクから読み込む */
export function loadWorkflow(agentDir: string, workflowId: string): WorkflowState | null {
  const filePath = resolveWorkflowPath(agentDir, workflowId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as WorkflowState;
  } catch {
    return null;
  }
}

/** ワークフロー状態をディスクに保存する */
export function saveWorkflow(agentDir: string, state: WorkflowState): void {
  const dir = resolveWorkflowDir(agentDir);
  ensureDir(dir);
  const filePath = resolveWorkflowPath(agentDir, state.workflowId);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** エージェント配下の全ワークフロー ID を列挙する */
export function listWorkflows(agentDir: string): string[] {
  const dir = resolveWorkflowDir(agentDir);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** 新しいワークフローを作成する */
export function createWorkflow(agentDir: string, params: CreateWorkflowParams): WorkflowState {
  const now = Date.now();
  const workflowId = crypto.randomUUID();
  const firstStepId = params.steps[0]?.id;
  if (!firstStepId) {
    throw new Error("Workflow must have at least one step");
  }

  const state: WorkflowState = {
    workflowId,
    label: params.label,
    currentStepId: firstStepId,
    steps: params.steps.map((s, i) => ({
      id: s.id,
      label: s.label,
      status: i === 0 ? "running" : "pending",
    })),
    completedStepIds: [],
    facts: [],
    openQuestions: [],
    currentPlan: params.plan ?? "",
    createdAt: now,
    updatedAt: now,
    sessionId: params.sessionId,
  };

  saveWorkflow(agentDir, state);
  return state;
}

/** 現在のステップを完了し、次のステップに進む */
export function advanceStep(agentDir: string, params: AdvanceStepParams): WorkflowState {
  const state = loadWorkflow(agentDir, params.workflowId);
  if (!state) {
    throw new Error(`Workflow not found: ${params.workflowId}`);
  }

  const targetStepId = params.stepId ?? state.currentStepId;
  const stepIndex = state.steps.findIndex((s) => s.id === targetStepId);
  if (stepIndex === -1) {
    throw new Error(`Step not found: ${targetStepId}`);
  }

  // Mark step as completed
  const step = state.steps[stepIndex];
  step.status = "completed";
  step.completedAt = Date.now();
  step.blockedReasons = undefined;
  if (!state.completedStepIds.includes(targetStepId)) {
    state.completedStepIds.push(targetStepId);
  }

  // Advance to next pending step
  const nextStep = state.steps.find((s) => s.status === "pending");
  if (nextStep) {
    nextStep.status = "running";
    state.currentStepId = nextStep.id;
  }

  // Update facts
  if (params.newFacts) {
    state.facts.push(...params.newFacts);
  }

  // Resolve questions
  if (params.resolvedQuestions) {
    const resolved = new Set(params.resolvedQuestions);
    state.openQuestions = state.openQuestions.filter((q) => !resolved.has(q));
  }

  // Add new questions
  if (params.newQuestions) {
    state.openQuestions.push(...params.newQuestions);
  }

  // Update plan
  if (params.planUpdate) {
    state.currentPlan = params.planUpdate;
  }

  state.updatedAt = Date.now();
  saveWorkflow(agentDir, state);
  return state;
}

/** ステップをブロック状態にする */
export function blockStep(agentDir: string, params: BlockStepParams): WorkflowState {
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

/** ワークフロー状態からコンテキスト注入用の要約を生成する */
export function buildContextSummary(state: WorkflowState): WorkflowContextSummary {
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
    blockedReasons: blockedStep?.blockedReasons ?? [],
  };
}

/** コンテキスト注入用の Markdown テキストを生成する */
export function renderContextMarkdown(state: WorkflowState): string {
  const summary = buildContextSummary(state);
  const sections: string[] = [];

  sections.push(`## Workflow: ${summary.label}`);
  sections.push(`**Progress:** ${summary.progress}`);
  sections.push(`**Current Step:** ${summary.currentStep}`);

  if (summary.blockedReasons.length > 0) {
    sections.push(`\n**Blocked:**\n${summary.blockedReasons.map((r) => `- ${r}`).join("\n")}`);
  }

  if (summary.plan) {
    sections.push(`\n### Plan\n${summary.plan}`);
  }

  if (summary.facts.length > 0) {
    sections.push(`\n### Known Facts\n${summary.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (summary.openQuestions.length > 0) {
    sections.push(
      `\n### Open Questions\n${summary.openQuestions.map((q) => `- ${q}`).join("\n")}`,
    );
  }

  // Step overview
  const stepLines = state.steps.map((s) => {
    const icon =
      s.status === "completed"
        ? "[x]"
        : s.status === "running"
          ? "[>]"
          : s.status === "blocked"
            ? "[!]"
            : "[ ]";
    return `- ${icon} ${s.label}`;
  });
  sections.push(`\n### Steps\n${stepLines.join("\n")}`);

  return sections.join("\n");
}
