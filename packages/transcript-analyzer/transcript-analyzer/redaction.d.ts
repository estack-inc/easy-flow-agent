/**
 * redaction：transcript excerpt 保存前に機密情報 6 種を redact する
 *
 * contracts.md §1.3 の RedactionType 6 種：
 *   participant / meeting_name / email / phone / address / credential
 *
 * 設計方針：
 * - 「過剰検出」優先：誤検出より redact 漏れの方が業務リスクが大きい
 * - excerpt 制約：1 件 500 文字、合計 2000 文字を保存前に保証
 * - source / token を log に出さない
 */
import type { Redaction } from "./types.js";
/** 1 citation excerpt の最大文字数 */
export declare const MAX_EXCERPT_CHARS_PER_CITATION = 500;
/** 1 response の citations excerpt 合計の最大文字数 */
export declare const MAX_TOTAL_EXCERPT_CHARS = 2000;
/**
 * 文字列内の機密情報を 6 種 redact する。
 *
 * @param text - redact 対象の文字列
 * @returns redacted text と検出 record の配列
 */
export declare function redactSensitive(text: string): {
    text: string;
    redactions: Redaction[];
};
/**
 * citation excerpt の文字数制約を適用する。
 *
 * - 1 excerpt 500 文字を超える場合は truncate + "..."
 * - 全 excerpt 合計が 2000 文字を超える場合、末尾 citation から順に truncate / drop
 *
 * @param excerpts - redact 済み excerpt の配列（順序保持）
 * @returns 制約適用後の excerpt 配列
 */
export declare function applyExcerptLimits(excerpts: string[]): string[];
/**
 * list_transcripts の summary_excerpt 用に redact を適用する。
 *
 * - participant / meeting_name は最も漏れやすいため強めに伏字化
 * - 元の文章構造は残し、機密 token のみ置換
 */
export declare function redactForListSummary(text: string | null | undefined): string | null;
//# sourceMappingURL=redaction.d.ts.map