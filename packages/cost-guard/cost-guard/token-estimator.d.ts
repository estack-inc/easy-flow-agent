/**
 * Token 数の見積もり（軽量近似）
 *
 * 新規依存追加を避けるため、tiktoken / @anthropic-ai/tokenizer を使わず、
 * UTF-8 byte 数ベースの近似式で token 数を見積もる。
 *
 * 近似式：tokens ≈ ceil(utf8_bytes / 4)
 *
 * 根拠：
 * - Claude / GPT 系の BPE tokenizer では英文 1 token ≈ 4 byte が経験則
 * - 日本語混在では 1 token ≈ 2 byte 程度になり過大評価になるが、Phase 1 では
 *   「閾値 50,000 token を超えたら block」という保守的判定のため過大評価は安全側
 * - 厳密な値が必要になれば fallback で tokenizer を import すれば良い（Phase 2 検討）
 *
 * 比較対象：
 * - prompt 全体（string）
 * - messages 配列（role / content / tool_call_id を JSON 化して合算）
 */
export interface SessionMessage {
    role: "user" | "assistant" | "tool" | "system";
    content: unknown;
    tool_call_id?: string;
    [key: string]: unknown;
}
/**
 * 文字列の UTF-8 byte 数を返す。
 */
export declare function utf8ByteLength(s: string): number;
/**
 * 文字列の token 数を近似する。
 *
 * @param s - 対象文字列
 * @returns 推定 token 数（ceil(utf8_bytes / 4)）
 */
export declare function estimateTokenCount(s: string): number;
/**
 * messages 配列全体の token 数を近似する。
 * 各 message の role / content / tool_call_id（あれば）を結合した文字列で見積もる。
 */
export declare function estimateMessagesTokenCount(messages: SessionMessage[] | undefined | null): number;
/**
 * prompt + messages の合計 token 数を近似する。
 * before_agent_run の段 1（per-turn prompt input gate）で次ターン入力の見積もりに使う。
 */
export declare function estimatePromptInputTokens(prompt: string | undefined, messages: SessionMessage[] | undefined): number;
