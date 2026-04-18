import type { TemplateSnapshot } from "./types.js";

export interface InferredTools {
  builtin: string[];
  warnings: string[];
}

export interface InferToolsHints {
  templateName: string;
}

/** `KNOWN_BUILTIN_TOOLS`（validator.ts 側）に含まれるもののみ識別子検出対象にする */
const DETECTABLE_TOOL_IDS = ["workflow-controller", "file-serve", "model-router"] as const;

const KNOWN_TEMPLATE_NAMES = new Set(["monitor", "executive-assistant"]);

/**
 * テンプレート構造を元に `tools.builtin[]` を推定する。
 * - 常に `workflow-controller` を含める
 * - `hasWorkspaceDir` が true のとき `file-serve` を追加
 * - `entrypoint.sh` / `TOOLS.md` に識別子が現れた場合は該当ツールを追加（重複排除）
 * - 既知テンプレート名以外でデフォルトしか当たらなかった場合は warnings に記録
 */
export function inferTools(snapshot: TemplateSnapshot, hints: InferToolsHints): InferredTools {
  const builtin: string[] = ["workflow-controller"];

  if (snapshot.hasWorkspaceDir && !builtin.includes("file-serve")) {
    builtin.push("file-serve");
  }

  const bodies = [snapshot.entrypointSh ?? "", snapshot.toolsMd ?? ""].join("\n");
  let detectedByIdentifier = false;
  for (const id of DETECTABLE_TOOL_IDS) {
    if (bodies.includes(id)) {
      detectedByIdentifier = true;
      if (!builtin.includes(id)) {
        builtin.push(id);
      }
    }
  }

  const warnings: string[] = [];
  const onlyDefault =
    builtin.length === 1 &&
    builtin[0] === "workflow-controller" &&
    !snapshot.hasWorkspaceDir &&
    !detectedByIdentifier;

  if (onlyDefault && !KNOWN_TEMPLATE_NAMES.has(hints.templateName)) {
    warnings.push(
      "ツール推定はデフォルトのみ適用しました。必要なら手動で tools.builtin を調整してください",
    );
  }

  return { builtin, warnings };
}
