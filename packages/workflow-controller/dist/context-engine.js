import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import { loadWorkflow, renderContextMarkdown } from "./store.js";
class WorkflowContextEngine {
  info = {
    id: "workflow",
    name: "Workflow Context Engine",
    version: "0.1.0"
  };
  delegate;
  agentDir;
  activeWorkflowId;
  constructor(params) {
    this.delegate = params.pinecone ? new PineconeContextEngine({
      pineconeClient: params.pinecone.client,
      agentId: params.pinecone.agentId,
      tokenBudget: params.pinecone.tokenBudget,
      ingestRoles: params.pinecone.ingestRoles,
      compactAfterDays: params.pinecone.compactAfterDays,
      fallbackAdapter: params.pinecone.fallbackAdapter ?? params.delegate,
      skipPatterns: params.pinecone.skipPatterns,
      defaultCategory: params.pinecone.defaultCategory
    }) : params.delegate;
    this.agentDir = params.agentDir;
    this.activeWorkflowId = params.activeWorkflowId;
  }
  /** アクティブなワークフロー ID を設定する */
  setActiveWorkflow(workflowId) {
    this.activeWorkflowId = workflowId;
  }
  /** エージェントディレクトリを設定する */
  setAgentDir(agentDir) {
    this.agentDir = agentDir;
  }
  async bootstrap(params) {
    if (this.delegate.bootstrap) {
      return this.delegate.bootstrap(params);
    }
    return { bootstrapped: false, reason: "delegate has no bootstrap" };
  }
  async ingest(params) {
    return this.delegate.ingest(params);
  }
  async ingestBatch(params) {
    if (this.delegate.ingestBatch) {
      return this.delegate.ingestBatch(params);
    }
    return { ingestedCount: 0 };
  }
  async afterTurn(params) {
    if (this.delegate.afterTurn) {
      await this.delegate.afterTurn(params);
    }
  }
  async assemble(params) {
    const baseResult = await this.delegate.assemble(params);
    const workflowAddition = this.buildWorkflowAddition();
    if (!workflowAddition) {
      return baseResult;
    }
    const existingAddition = baseResult.systemPromptAddition ?? "";
    const separator = existingAddition ? "\n\n" : "";
    return {
      ...baseResult,
      systemPromptAddition: `${existingAddition}${separator}${workflowAddition}`
    };
  }
  async compact(params) {
    return this.delegate.compact(params);
  }
  async dispose() {
    if (this.delegate.dispose) {
      await this.delegate.dispose();
    }
  }
  /**
   * アクティブなワークフロー状態を Markdown に変換する。
   * bootstrap 予算外で systemPromptAddition として注入される。
   */
  buildWorkflowAddition() {
    if (!this.agentDir || !this.activeWorkflowId) {
      return null;
    }
    const state = loadWorkflow(this.agentDir, this.activeWorkflowId);
    if (!state) {
      return null;
    }
    return `# Active Workflow

${renderContextMarkdown(state)}`;
  }
}
export {
  WorkflowContextEngine
};
