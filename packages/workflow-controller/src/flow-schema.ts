/**
 * フロー定義 JSON のバリデーション関数
 *
 * V1（flowId 重複）・V2（trigger 重複）は flow-loader 側で検証する。
 * この関数では V3〜V13 を検証する。
 */

export interface FlowDefinition {
  version?: number;
  flowId: string;
  trigger: string;
  label: string;
  description?: string;
  steps: FlowStepDefinition[];
}

export interface FlowStepDefinition {
  id: string;
  label: string;
  nextStepId?: string;
  conditions?: Array<{
    label: string;
    nextStepId: string;
  }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const ALLOWED_TOP_LEVEL = new Set([
  "$schema",
  "version",
  "flowId",
  "trigger",
  "label",
  "description",
  "steps",
]);
const ALLOWED_STEP_KEYS = new Set(["id", "label", "nextStepId", "conditions"]);
const ALLOWED_CONDITION_KEYS = new Set(["label", "nextStepId"]);
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 単一のフロー定義 JSON をバリデーションする。
 */
export function validateFlowDefinition(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    errors.push("フロー定義はオブジェクトである必要があります");
    return { valid: false, errors, warnings };
  }

  const obj = data as Record<string, unknown>;

  // V11: 未知のプロパティ検出（トップレベル）
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      warnings.push(`未知のトップレベルプロパティ: '${key}'`);
    }
  }

  // V9: 必須プロパティの存在チェック
  if (!("flowId" in obj) || typeof obj.flowId !== "string") {
    errors.push("必須プロパティ 'flowId' が存在しないか文字列ではありません");
  }
  if (!("trigger" in obj) || typeof obj.trigger !== "string") {
    errors.push("必須プロパティ 'trigger' が存在しないか文字列ではありません");
  }
  if (!("label" in obj) || typeof obj.label !== "string") {
    errors.push("必須プロパティ 'label' が存在しないか文字列ではありません");
  }
  if (!("steps" in obj) || !Array.isArray(obj.steps)) {
    errors.push("必須プロパティ 'steps' が存在しないか配列ではありません");
  }

  // 必須プロパティがない場合はここで終了
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const flowId = obj.flowId as string;
  const trigger = obj.trigger as string;
  const label = obj.label as string;
  const steps = obj.steps as unknown[];

  // V13: version が省略または整数 1
  if ("version" in obj) {
    const v = obj.version;
    if (typeof v !== "number" || !Number.isInteger(v) || v !== 1) {
      errors.push(`'version' は整数 1 である必要があります（現在: ${JSON.stringify(v)}）`);
    }
  }

  // V10: flowId が snake_case
  if (!SNAKE_CASE_RE.test(flowId)) {
    errors.push(
      `'flowId' の値 '${flowId}' は snake_case ではありません（/^[a-z][a-z0-9_]*$/ に一致する必要があります）`,
    );
  }

  // V12: trigger・label が空文字列でないこと
  if (trigger === "") {
    errors.push("'trigger' は空文字列にできません");
  }
  if (label === "") {
    errors.push("'label' は空文字列にできません");
  }

  // V3: steps が 1 つ以上
  if (steps.length === 0) {
    errors.push("'steps' は 1 つ以上のステップが必要です");
    return { valid: errors.length === 0, errors, warnings };
  }

  // steps の各要素をバリデーション
  const stepIds = new Set<string>();
  const stepIdList: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      errors.push(`steps[${i}] はオブジェクトである必要があります`);
      continue;
    }
    const s = step as Record<string, unknown>;

    // V11: 未知の step プロパティ
    for (const key of Object.keys(s)) {
      if (!ALLOWED_STEP_KEYS.has(key)) {
        warnings.push(`steps[${i}] に未知のプロパティ: '${key}'`);
      }
    }

    // V9: steps[].id と steps[].label の型チェック
    if (!("id" in s) || typeof s.id !== "string") {
      errors.push(`steps[${i}].id が存在しないか文字列ではありません`);
    } else {
      const stepId = s.id as string;

      // V4: step.id が snake_case
      if (!SNAKE_CASE_RE.test(stepId)) {
        errors.push(`steps[${i}].id '${stepId}' は snake_case ではありません`);
      }

      // V5: step.id がフロー内で一意
      if (stepIds.has(stepId)) {
        errors.push(`steps[${i}].id '${stepId}' はフロー内で重複しています`);
      } else {
        stepIds.add(stepId);
        stepIdList.push(stepId);
      }
    }

    if (!("label" in s) || typeof s.label !== "string") {
      errors.push(`steps[${i}].label が存在しないか文字列ではありません`);
    } else {
      // V12: steps[].label が空でないこと
      if ((s.label as string) === "") {
        errors.push(`steps[${i}].label は空文字列にできません`);
      }
    }

    // conditions のバリデーション
    if ("conditions" in s && s.conditions !== undefined) {
      if (!Array.isArray(s.conditions)) {
        errors.push(`steps[${i}].conditions は配列である必要があります`);
      } else if ((s.conditions as unknown[]).length > 0) {
        // 空配列は OK（undefined と同義）
        const conds = s.conditions as unknown[];
        for (let j = 0; j < conds.length; j++) {
          const cond = conds[j];
          if (typeof cond !== "object" || cond === null || Array.isArray(cond)) {
            errors.push(`steps[${i}].conditions[${j}] はオブジェクトである必要があります`);
            continue;
          }
          const c = cond as Record<string, unknown>;

          // V11: 未知の condition プロパティ
          for (const key of Object.keys(c)) {
            if (!ALLOWED_CONDITION_KEYS.has(key)) {
              warnings.push(`steps[${i}].conditions[${j}] に未知のプロパティ: '${key}'`);
            }
          }

          // V12: conditions[].label が空でないこと
          if (!("label" in c) || typeof c.label !== "string") {
            errors.push(`steps[${i}].conditions[${j}].label が存在しないか文字列ではありません`);
          } else if ((c.label as string) === "") {
            errors.push(`steps[${i}].conditions[${j}].label は空文字列にできません`);
          }

          if (!("nextStepId" in c) || typeof c.nextStepId !== "string") {
            errors.push(
              `steps[${i}].conditions[${j}].nextStepId が存在しないか文字列ではありません`,
            );
          }
          // V6 は stepIds 確定後に後でチェック
        }
      }
    }
  }

  // V6: conditions[].nextStepId が有効な steps[].id を参照
  // V7: nextStepId が有効な steps[].id を参照
  // （stepIds が確定した後に再走査）
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (typeof step !== "object" || step === null || Array.isArray(step)) continue;
    const s = step as Record<string, unknown>;

    // V7
    if ("nextStepId" in s && typeof s.nextStepId === "string") {
      if (!stepIds.has(s.nextStepId as string)) {
        errors.push(
          `steps[${i}].nextStepId '${s.nextStepId}' はフロー内に存在しない id を参照しています`,
        );
      }
    }

    // V6
    if ("conditions" in s && Array.isArray(s.conditions)) {
      const conds = s.conditions as unknown[];
      for (let j = 0; j < conds.length; j++) {
        const cond = conds[j];
        if (typeof cond !== "object" || cond === null || Array.isArray(cond)) continue;
        const c = cond as Record<string, unknown>;
        if ("nextStepId" in c && typeof c.nextStepId === "string") {
          if (!stepIds.has(c.nextStepId as string)) {
            errors.push(
              `steps[${i}].conditions[${j}].nextStepId '${c.nextStepId}' はフロー内に存在しない id を参照しています`,
            );
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
