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
/**
 * tool params を再帰走査し、commandDenylist にマッチする command パターンを探す。
 */
export declare function findCommandDenylistMatch(params: unknown, options: CommandCheckOptions): CommandMatchResult | null;
/**
 * command 文字列に deny pattern が含まれているか判定する。
 *
 * Phase 1 では正規表現ではなく文字列 contains で判定（false positive を許容しつつ、
 * 設計書に明記された 6 パターンを確実に捕捉する）。
 */
export declare function containsCommandPattern(command: string, pattern: string): boolean;
