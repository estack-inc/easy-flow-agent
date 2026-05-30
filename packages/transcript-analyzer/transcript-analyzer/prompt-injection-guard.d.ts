/**
 * transcript 内の prompt injection 兆候を検出する。
 *
 * @param transcriptContent - 検査対象の transcript 全文
 * @returns 検出した injection 種別名の配列（重複なし）
 */
export declare function detectPromptInjection(transcriptContent: string): string[];
/**
 * Gemini に渡す prompt の組み立て。
 *
 * transcript を「引用元データ」として明示的に隔離し、prompt injection を
 * 中和する system 指示で囲む。本関数は再利用可能なため、unit test で
 * prompt 内に必要な隔離指示が含まれることを直接検証できる。
 *
 * @param transcriptContent - 引用元 transcript の全文
 * @param userQuery - ユーザーの query
 * @returns Gemini に渡す full prompt
 */
export declare function buildAnalyzePrompt(transcriptContent: string, userQuery: string): string;
/**
 * citation の byte_range が transcript 全体のバイト数を超えていないかを検証する。
 * （Gemini が捏造した byte_range を後段で fix するための post-validate）
 *
 * @param byteRange - [start, end]
 * @param transcriptByteLength - transcript の合計バイト数
 * @returns true なら有効、false なら無効（warning として記録すべき）
 */
export declare function isCitationByteRangeValid(byteRange: [number, number] | undefined | null, transcriptByteLength: number): boolean;
//# sourceMappingURL=prompt-injection-guard.d.ts.map