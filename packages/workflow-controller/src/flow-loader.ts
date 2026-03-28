/**
 * フロー定義 JSON ファイルの読み込み・キャッシュ・検索
 *
 * V1（flowId 重複）・V2（trigger 重複）はこのモジュールで検証する。
 * V8（JSON パースエラー）もここで処理する。
 */

import fs from "node:fs";
import path from "node:path";
import { type FlowDefinition, validateFlowDefinition } from "./flow-schema.js";

export type { FlowDefinition };

export interface FlowLoaderLogger {
  warn(message: string): void;
  info(message: string): void;
}

// モジュールレベルキャッシュ
let cachedFlows: FlowDefinition[] = [];

/**
 * 指定ディレクトリ内の .json ファイルをアルファベット昇順で読み込む。
 * バリデーション（V3〜V13）を実行し、不正ファイルは警告して無視する。
 * V1（flowId 重複）・V2（trigger 重複）をファイル間で検証する。
 * 結果をモジュールレベルでキャッシュする。
 */
export function loadFlowDefinitions(
  workflowsDir: string,
  logger?: FlowLoaderLogger,
): FlowDefinition[] {
  // ディレクトリが不在の場合は空配列
  if (!fs.existsSync(workflowsDir)) {
    cachedFlows = [];

    return [];
  }

  let fileNames: string[];
  try {
    fileNames = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".json"))
      .sort(); // アルファベット昇順
  } catch (err) {
    logger?.warn(`workflow-controller: ディレクトリ読み込み失敗: ${workflowsDir}: ${err}`);
    cachedFlows = [];

    return [];
  }

  const seenFlowIds = new Map<string, string>(); // flowId → filename
  const seenTriggers = new Map<string, string>(); // trigger → filename
  const validFlows: FlowDefinition[] = [];

  for (const fileName of fileNames) {
    const filePath = path.join(workflowsDir, fileName);

    // ファイル読み込み
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      logger?.warn(`workflow-controller: ファイル読み込み失敗 '${fileName}': ${err}`);
      continue;
    }

    // BOM 除去（V8）
    if (raw.startsWith("\uFEFF")) {
      raw = raw.slice(1);
    }

    // JSON パース（V8）
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger?.warn(`workflow-controller: JSON パースエラー '${fileName}': ${err}`);
      continue;
    }

    // バリデーション（V3〜V13）
    const result = validateFlowDefinition(parsed);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        logger?.warn(`workflow-controller: [${fileName}] ${w}`);
      }
    }

    if (!result.valid) {
      for (const e of result.errors) {
        logger?.warn(`workflow-controller: バリデーションエラー '${fileName}': ${e}`);
      }
      continue;
    }

    const flow = parsed as FlowDefinition;

    // V1: flowId 重複チェック
    if (seenFlowIds.has(flow.flowId)) {
      logger?.warn(
        `workflow-controller: flowId '${flow.flowId}' が重複しています。'${fileName}' を無視します（先行: '${seenFlowIds.get(flow.flowId)}'）`,
      );
      continue;
    }

    // V2: trigger 重複チェック
    if (seenTriggers.has(flow.trigger)) {
      logger?.warn(
        `workflow-controller: trigger '${flow.trigger}' が重複しています。'${fileName}' を無視します（先行: '${seenTriggers.get(flow.trigger)}'）`,
      );
      continue;
    }

    seenFlowIds.set(flow.flowId, fileName);
    seenTriggers.set(flow.trigger, fileName);
    validFlows.push(Object.freeze(flow));
  }

  cachedFlows = validFlows;
  return [...validFlows];
}

/** trigger で完全一致検索。キャッシュから取得。 */
export function getFlowByTrigger(trigger: string): FlowDefinition | undefined {
  return cachedFlows.find((f) => f.trigger === trigger);
}

/** flowId で検索。キャッシュから取得。 */
export function getFlowById(flowId: string): FlowDefinition | undefined {
  return cachedFlows.find((f) => f.flowId === flowId);
}

/** 読み込み済みの全フロー定義を返す */
export function listFlows(): FlowDefinition[] {
  return [...cachedFlows];
}

/** @internal テスト用: キャッシュをクリアする */
export function _resetCache(): void {
  cachedFlows = [];
}
