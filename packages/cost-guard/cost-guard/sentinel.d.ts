/**
 * sentinel 文字列生成と判定
 *
 * tool_result_persist で result が rewriteThresholdBytes を超えた場合に
 * 置換用の sentinel メッセージを生成する。フォーマットは contracts.md §2.2 準拠。
 *
 * 例：
 *   "[cost-guard] tool result truncated (105234 bytes). Use analyze_transcript or specific tool to access content."
 */
export declare const SENTINEL_PREFIX = "[cost-guard] tool result truncated";
/**
 * sentinel メッセージを生成する。
 *
 * @param originalBytes - 置換前の content の byte 数
 * @returns sentinel 文字列
 */
export declare function buildSentinelMessage(originalBytes: number): string;
/**
 * 与えられた値の byte 数を計算する。
 *
 * - string: UTF-8 byte 数
 * - object / array: JSON.stringify した文字列の UTF-8 byte 数
 * - undefined / null: 0
 * - その他 (number / boolean): String 化した byte 数
 */
export declare function computeContentBytes(value: unknown): number;
/**
 * 文字列が sentinel メッセージかを判定する。
 * before_agent_run の cleanup 時に「既に置換済みの message」を再置換しないために使用する。
 */
export declare function isSentinelMessage(content: unknown): boolean;
