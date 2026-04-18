import type { Agentfile } from "../agentfile/types.js";

export interface ConvertOptions {
  /** テンプレート名（monitor / executive-assistant など） */
  template: string;
  /** 変換元テンプレートディレクトリのパス（省略時は openclaw-templates の既定パスを探索） */
  sourceDir?: string;
  /** 出力先 YAML パス（省略時は標準出力） */
  output?: string;
}

export interface ConvertResult {
  agentfile: Agentfile;
  /** 生成された YAML 文字列 */
  yaml: string;
  /** 変換に使用した入力ファイル一覧 */
  inputFiles: string[];
  /** 推定できなかった・警告のあった項目 */
  warnings: string[];
}

/** テンプレートディレクトリから読み込んだ生データ */
export interface TemplateSnapshot {
  identityMd?: string;
  soulMd?: string;
  policyMd?: string;
  agentsMd?: string;
  agentsCoreMd?: string;
  toolsMd?: string;
  readmeMd?: string;
  metaJson?: TemplateMeta;
  entrypointSh?: string;
  /** 読み込んだディレクトリの絶対パス */
  rootDir: string;
  /** `<rootDir>/workspace/` ディレクトリが存在するか */
  hasWorkspaceDir: boolean;
}

/** openclaw-templates の meta.json 最小スキーマ */
export interface TemplateMeta {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  [key: string]: unknown;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}
