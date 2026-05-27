/**
 * Command denylist の AST 検査（軽量版）
 *
 * shell injection 経由で denyPaths 配下を読みに行く command パターンを捕捉する。
 * tool params の command-like field（command / cmd / script / shell / args）に対して
 * commandDenylist の各パターンが含まれているかを検査する。
 *
 * 既定パターン（contracts.md §9.1）：
 * - "eval"       : eval ベースの動的実行
 * - "bash -c $"  : bash -c $VAR 経由の path 隠蔽
 * - "sh -c $"    : sh -c $VAR 経由の path 隠蔽
 * - "<("         : process substitution
 * - "$("         : command substitution
 * - "`"          : backtick command substitution
 *
 * 検査方針：
 * - command 文字列を shell quote を考慮して軽く token 化し、`bash|sh -c` の script 引数を検査
 * - 全文 substring match と shell token match の OR を取る（false negative より false positive を許容）
 * - false positive を避けるため、deny pattern は文字列単純 contains（正規表現ではない）
 */

export interface CommandCheckOptions {
  commandDenylist: string[];
}

export interface CommandMatchResult {
  field: string;
  matchedPattern: string;
}

const COMMAND_LIKE_FIELDS = new Set(["command", "cmd", "script", "shell"]);

/**
 * tool params を再帰走査し、commandDenylist にマッチする command パターンを探す。
 */
export function findCommandDenylistMatch(
  params: unknown,
  options: CommandCheckOptions,
): CommandMatchResult | null {
  const patterns = options.commandDenylist.filter((s) => typeof s === "string" && s.length > 0);
  if (patterns.length === 0) return null;
  const visited = new WeakSet<object>();

  function walk(value: unknown, fieldPath: string): CommandMatchResult | null {
    if (typeof value === "string") {
      const leaf = leafKey(fieldPath);
      const isCommand = COMMAND_LIKE_FIELDS.has(leaf) || leaf.startsWith("args");
      if (!isCommand) return null;
      for (const pattern of patterns) {
        if (containsCommandPattern(value, pattern)) {
          return { field: fieldPath, matchedPattern: pattern };
        }
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    if (visited.has(value as object)) return null;
    visited.add(value as object);

    if (Array.isArray(value)) {
      const leaf = leafKey(fieldPath);
      const isCommandArray = COMMAND_LIKE_FIELDS.has(leaf) || leaf.startsWith("args");
      // 個別要素を先に検査（具体的 index を優先報告）。
      // 単一要素内に pattern が完全に含まれる場合は `args[N]` 形式で field を返す。
      for (let i = 0; i < value.length; i++) {
        const r = walk(value[i], `${fieldPath}[${i}]`);
        if (r) return r;
      }
      // 個別要素では見つからなかった場合のみ、結合スキャンで要素を跨ぐ pattern を捕捉。
      // 例: args: ["bash", "-c", "$VAR"] → joined "bash -c $VAR" → "bash -c $" にマッチ → field: "args"
      if (isCommandArray && value.every((item): item is string => typeof item === "string")) {
        for (const pattern of patterns) {
          if (containsCommandPatternInArgs(value, pattern)) {
            return { field: fieldPath, matchedPattern: pattern };
          }
        }
      }
      return null;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      const childField = fieldPath === "" ? k : `${fieldPath}.${k}`;
      const r = walk(v, childField);
      if (r) return r;
    }
    return null;
  }

  return walk(params, "");
}

function leafKey(fieldPath: string): string {
  return (
    fieldPath
      .split(".")
      .at(-1)
      ?.replace(/\[\d+\]$/g, "")
      .toLowerCase() ?? ""
  );
}

/**
 * command 文字列に deny pattern が含まれているか判定する。
 *
 * Phase 1 では正規表現ではなく文字列 contains で判定（false positive を許容しつつ、
 * 設計書に明記された 6 パターンを確実に捕捉する）。
 */
export function containsCommandPattern(command: string, pattern: string): boolean {
  // 完全 substring match
  if (command.includes(pattern)) return true;
  if (pattern === "bash -c $" && hasShellCExpansion(command, "bash")) return true;
  if (pattern === "sh -c $" && hasShellCExpansion(command, "sh")) return true;
  return false;
}

function containsCommandPatternInArgs(args: string[], pattern: string): boolean {
  if (args.join(" ").includes(pattern)) return true;
  if (pattern === "bash -c $" && hasShellCExpansionTokens(args, "bash")) return true;
  if (pattern === "sh -c $" && hasShellCExpansionTokens(args, "sh")) return true;
  return false;
}

function hasShellCExpansion(command: string, shellName: "bash" | "sh"): boolean {
  return hasShellCExpansionTokens(tokenizeShellCommand(command), shellName);
}

function hasShellCExpansionTokens(tokens: string[], shellName: "bash" | "sh"): boolean {
  for (let i = 0; i < tokens.length - 2; i++) {
    if (pathBasename(tokens[i]) !== shellName) continue;
    if (!isShellCommandOption(tokens[i + 1])) continue;
    if (containsShellExpansion(tokens[i + 2])) return true;
  }
  return false;
}

function isShellCommandOption(token: string): boolean {
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(token);
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (quote === null && /\s|[|;&]/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current !== "") tokens.push(current);
  return tokens;
}

function pathBasename(value: string): string {
  return value.split("/").at(-1) ?? value;
}

function containsShellExpansion(script: string): boolean {
  return /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\}|\()/.test(script) || script.includes("`");
}
