/**
 * transcript-analyzer 型定義
 *
 * contracts.md §1.3「tool 戻り値 / 引数の型定義」を正本として実装する。
 * 本ファイルでは shape を再宣言するが、契約の変更は必ず contracts.md を
 * 先に更新し、本ファイルを追従させる。
 */
// ----------------------------------------------------------------------------
// 「Sonnet 全文 fallback は禁止」を type レベルで明示するため、
// fallback 先 model 名の許可リストを expose する。runtime check と
// test 側 assertNotCalled の両方で活用する。
// ----------------------------------------------------------------------------
/** fallbackModel として許可される model 名の prefix。Sonnet / claude 等を含まないことを保証 */
export const ALLOWED_FALLBACK_MODEL_PREFIXES = ["gemini-"];
/** 禁止 model 名の token（runtime check 用） */
export const FORBIDDEN_MODEL_TOKENS = ["sonnet", "claude", "anthropic"];
/**
 * 禁止 model 名が混入していないかを検査する。
 * 違反時は throw する（fallback 経路に sonnet が紛れ込んだら絶対に呼ばせない）。
 */
export function assertNotForbiddenModel(modelName) {
    const lower = modelName.toLowerCase();
    for (const token of FORBIDDEN_MODEL_TOKENS) {
        if (lower.includes(token)) {
            throw new Error(`[transcript-analyzer] forbidden model detected: ${modelName}. Sonnet 全文 fallback is disabled by design.`);
        }
    }
}
/**
 * model が明示的に Gemini 系であることを検査する。
 */
export function assertAllowedGeminiModel(modelName) {
    assertNotForbiddenModel(modelName);
    const lower = modelName.toLowerCase();
    if (!ALLOWED_FALLBACK_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        throw new Error(`[transcript-analyzer] unsupported Gemini model: ${modelName}. model must start with one of: ${ALLOWED_FALLBACK_MODEL_PREFIXES.join(", ")}`);
    }
}
//# sourceMappingURL=types.js.map