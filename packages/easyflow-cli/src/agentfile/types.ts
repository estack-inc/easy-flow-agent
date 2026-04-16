/** Agentfile のトップレベル構造 */
export interface Agentfile {
  apiVersion: "easyflow/v1";
  kind: "Agent";
  metadata: AgentMetadata;
  base?: string;
  identity: AgentIdentity;
  agents_core?: AgentsCore;
  knowledge?: AgentKnowledge;
  tools?: AgentTools;
  channels?: AgentChannels;
  config?: AgentConfig;
}

export interface AgentMetadata {
  /** ^[a-z0-9][a-z0-9-]*$, 3-64 文字 */
  name: string;
  /** semver */
  version: string;
  description: string;
  author: string;
  labels?: Record<string, string>;
}

export interface AgentIdentity {
  name: string;
  /** 必須 — エージェントの核 */
  soul: string;
  policy?: string[];
}

export interface AgentsCore {
  /** ファイルパス参照（inline と排他） */
  file?: string;
  /** インライン記述（file と排他） */
  inline?: string;
}

export interface AgentKnowledge {
  sources: KnowledgeSource[];
  config?: KnowledgeConfig;
}

export interface KnowledgeSource {
  path: string;
  type: "agents_rule" | "customer_doc" | "memory_entry";
  description: string;
  ignore?: string[];
}

export interface KnowledgeConfig {
  /** デフォルト: 400 */
  chunk_size?: number;
  /** デフォルト: 50 */
  chunk_overlap?: number;
  /** デフォルト: 0.75 */
  min_score?: number;
  /** デフォルト: 10 */
  top_k?: number;
  /** デフォルト: 2000 */
  token_budget?: number;
}

export interface AgentTools {
  builtin?: string[];
  custom?: CustomTool[];
}

export interface CustomTool {
  path: string;
  name: string;
}

export interface AgentChannels {
  slack?: ChannelConfig;
  line?: ChannelConfig;
  webchat?: WebchatChannelConfig;
}

export interface ChannelConfig {
  enabled: boolean;
}

export interface WebchatChannelConfig extends ChannelConfig {
  invite_codes?: string[];
}

export interface AgentConfig {
  model?: ModelConfig;
  rag?: { enabled: boolean };
  env?: Record<string, string>;
}

export interface ModelConfig {
  default?: string;
  thinking?: string;
}
