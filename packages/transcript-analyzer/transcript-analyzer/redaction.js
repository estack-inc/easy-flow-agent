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
/** 1 citation excerpt の最大文字数 */
export const MAX_EXCERPT_CHARS_PER_CITATION = 500;
/** 1 response の citations excerpt 合計の最大文字数 */
export const MAX_TOTAL_EXCERPT_CHARS = 2000;
/** redact 後の置換文字列（type 別） */
const PLACEHOLDER = {
    participant: "[REDACTED_PARTICIPANT]",
    meeting_name: "[REDACTED_MEETING]",
    email: "[REDACTED_EMAIL]",
    phone: "[REDACTED_PHONE]",
    address: "[REDACTED_ADDRESS]",
    credential: "[REDACTED_CREDENTIAL]",
};
// ----------------------------------------------------------------------------
// 検出パターン（過剰検出寄り）
// ----------------------------------------------------------------------------
// email：最低限の RFC 互換（local-part@domain）
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 電話番号：日本/国際の代表的フォーマット
//   090-1234-5678, +81 90 1234 5678, (03)1234-5678 等を捕捉
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)|\d{2,4})[-.\s]?\d{2,4}[-.\s]?\d{3,4}/g;
// credential：「password」「api_key」「token」「secret」を含む行 + 隣接した key=value 形式
const CREDENTIAL_PATTERN = /\b(?:password|api[_-]?key|secret|access[_-]?token|bearer|auth[_-]?token)\b\s*[:=]\s*\S+/gi;
// 住所：日本語住所の代表パターン（都道府県/市区町村/丁番地）
const ADDRESS_PATTERN = /(?:[東-鿿ｦ-ﾟ]{1,5}(?:都|道|府|県))?[東-鿿ｦ-ﾟ]{1,10}(?:市|区|町|村)[0-9東-鿿ｦ-ﾟ\-\s]{0,30}(?:番地|丁目|番|号)?/g;
// participant：「参加者:」「発言者:」「Speaker:」等のラベル直後の名前リスト
const PARTICIPANT_PATTERN = /(?:参加者|発言者|司会|発表者|出席者|Speaker|Participant|Host)\s*[:：]\s*([^\n]{1,200})/g;
// meeting_name：「件名:」「議題:」「会議名:」「Subject:」「Meeting:」等のラベル直後
const MEETING_PATTERN = /(?:件名|議題|会議名|タイトル|Subject|Meeting|Title)\s*[:：]\s*([^\n]{1,80})/g;
// ----------------------------------------------------------------------------
// 実装
// ----------------------------------------------------------------------------
/**
 * 文字列内の機密情報を 6 種 redact する。
 *
 * @param text - redact 対象の文字列
 * @returns redacted text と検出 record の配列
 */
export function redactSensitive(text) {
    if (typeof text !== "string" || text.length === 0) {
        return { text: text ?? "", redactions: [] };
    }
    const redactions = [];
    let result = text;
    const now = new Date().toISOString();
    // 検出順序は「ラベル付き → label-less」の順で固定。順序逆転すると
    // 名前らしき token が phone / address に先に吸われる risk があるため。
    const passes = [
        { type: "credential", pattern: CREDENTIAL_PATTERN },
        { type: "email", pattern: EMAIL_PATTERN },
        { type: "meeting_name", pattern: MEETING_PATTERN, group: 1 },
        { type: "participant", pattern: PARTICIPANT_PATTERN, group: 1 },
        { type: "phone", pattern: PHONE_PATTERN },
        { type: "address", pattern: ADDRESS_PATTERN },
    ];
    for (const pass of passes) {
        result = result.replace(pass.pattern, (match, ...groups) => {
            const captured = pass.group !== undefined && typeof groups[pass.group - 1] === "string"
                ? groups[pass.group - 1]
                : match;
            redactions.push({
                type: pass.type,
                original_length: captured.length,
                redacted_at: now,
            });
            // group 指定時は capture 部分のみ replace、それ以外は match 全体を replace
            if (pass.group !== undefined) {
                return match.replace(captured, PLACEHOLDER[pass.type]);
            }
            return PLACEHOLDER[pass.type];
        });
    }
    return { text: result, redactions };
}
/**
 * citation excerpt の文字数制約を適用する。
 *
 * - 1 excerpt 500 文字を超える場合は truncate + "..."
 * - 全 excerpt 合計が 2000 文字を超える場合、末尾 citation から順に truncate / drop
 *
 * @param excerpts - redact 済み excerpt の配列（順序保持）
 * @returns 制約適用後の excerpt 配列
 */
export function applyExcerptLimits(excerpts) {
    if (!Array.isArray(excerpts) || excerpts.length === 0)
        return [];
    // ステップ 1：1 件 500 文字制限
    const trimmedPerItem = excerpts.map((e) => {
        if (typeof e !== "string")
            return "";
        if (e.length <= MAX_EXCERPT_CHARS_PER_CITATION)
            return e;
        return `${e.slice(0, MAX_EXCERPT_CHARS_PER_CITATION - 3)}...`;
    });
    // ステップ 2：合計 2000 文字制限
    const result = [];
    let total = 0;
    for (const e of trimmedPerItem) {
        if (total >= MAX_TOTAL_EXCERPT_CHARS) {
            // 合計上限に達したら、以降は空文字（後段で drop / truncate される）
            result.push("");
            continue;
        }
        if (total + e.length <= MAX_TOTAL_EXCERPT_CHARS) {
            result.push(e);
            total += e.length;
            continue;
        }
        const remaining = MAX_TOTAL_EXCERPT_CHARS - total;
        if (remaining <= 3) {
            result.push("");
            total = MAX_TOTAL_EXCERPT_CHARS;
            continue;
        }
        result.push(`${e.slice(0, remaining - 3)}...`);
        total = MAX_TOTAL_EXCERPT_CHARS;
    }
    return result;
}
/**
 * list_transcripts の summary_excerpt 用に redact を適用する。
 *
 * - participant / meeting_name は最も漏れやすいため強めに伏字化
 * - 元の文章構造は残し、機密 token のみ置換
 */
export function redactForListSummary(text) {
    if (text === null || text === undefined || text.length === 0)
        return null;
    const { text: redacted } = redactSensitive(text);
    // summary は短く保つ：80 文字までに truncate
    const truncated = redacted.length > 80 ? `${redacted.slice(0, 77)}...` : redacted;
    return truncated;
}
//# sourceMappingURL=redaction.js.map