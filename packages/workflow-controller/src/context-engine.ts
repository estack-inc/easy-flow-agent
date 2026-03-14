import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  IngestBatchResult,
  BootstrapResult,
} from "openclaw/plugin-sdk";
import {
  PineconeContextEngine,
  type IPineconeClient,
} from "@easy-flow/pinecone-context-engine";

type ContextEngineRuntimeContext = Record<string, unknown>;
import { loadWorkflow, renderContextMarkdown } from "./store.js";

/**
 * WorkflowContextEngine — LegacyContextEngine をラップし、
 * ワークフロー状態を systemPromptAddition として動的注入する。
 *
 * 設計:
 * - assemble() で WorkflowState を Markdown 化し systemPromptAddition に含める
 * - ingest/compact/afterTurn は内部の delegate（LegacyContextEngine）に委譲
 * - bootstrap 予算（150,000 chars）を消費せず、systemPromptAddition 経由で注入
 */
export class WorkflowContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "workflow",
    name: "Workflow Context Engine",
    version: "0.1.0",
  };

  private delegate: ContextEngine;
  private agentDir: string | undefined;
  private activeWorkflowId: string | undefined;

  constructor(params: {
    delegate: ContextEngine;
    agentDir?: string;
    activeWorkflowId?: string;
    pinecone?: {
      client: IPineconeClient;
      tokenBudget?: number;
      ingestRoles?: ("user" | "assistant")[];
      compactAfterDays?: number;
      fallbackAdapter?: ContextEngine;
    };
  }) {
    this.delegate = params.pinecone
      ? new PineconeContextEngine({
          pineconeClient: params.pinecone.client,
          agentId: params.agentDir ?? "default",
          tokenBudget: params.pinecone.tokenBudget,
          ingestRoles: params.pinecone.ingestRoles,
          compactAfterDays: params.pinecone.compactAfterDays,
          fallbackAdapter: params.pinecone.fallbackAdapter ?? params.delegate,
        })
      : params.delegate;
    this.agentDir = params.agentDir;
    this.activeWorkflowId = params.activeWorkflowId;
  }

  /** アクティブなワークフロー ID を設定する */
  setActiveWorkflow(workflowId: string | undefined): void {
    this.activeWorkflowId = workflowId;
  }

  /** エージェントディレクトリを設定する */
  setAgentDir(agentDir: string): void {
    this.agentDir = agentDir;
  }

  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    if (this.delegate.bootstrap) {
      return this.delegate.bootstrap(params);
    }
    return { bootstrapped: false, reason: "delegate has no bootstrap" };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.delegate.ingest(params);
  }

  async ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    if (this.delegate.ingestBatch) {
      return this.delegate.ingestBatch(params);
    }
    return { ingestedCount: 0 };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    if (this.delegate.afterTurn) {
      await this.delegate.afterTurn(params);
    }
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Delegate the base assembly
    const baseResult = await this.delegate.assemble(params);

    // Inject workflow context if available
    const workflowAddition = this.buildWorkflowAddition();
    if (!workflowAddition) {
      return baseResult;
    }

    const existingAddition = baseResult.systemPromptAddition ?? "";
    const separator = existingAddition ? "\n\n" : "";

    return {
      ...baseResult,
      systemPromptAddition: `${existingAddition}${separator}${workflowAddition}`,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return this.delegate.compact(params);
  }

  async dispose(): Promise<void> {
    if (this.delegate.dispose) {
      await this.delegate.dispose();
    }
  }

  /**
   * アクティブなワークフロー状態を Markdown に変換する。
   * bootstrap 予算外で systemPromptAddition として注入される。
   */
  private buildWorkflowAddition(): string | null {
    if (!this.agentDir || !this.activeWorkflowId) {
      return null;
    }

    const state = loadWorkflow(this.agentDir, this.activeWorkflowId);
    if (!state) {
      return null;
    }

    return `# Active Workflow\n\n${renderContextMarkdown(state)}`;
  }
}
