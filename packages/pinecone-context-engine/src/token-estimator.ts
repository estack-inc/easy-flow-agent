/**
 * Estimate token count from text.
 *
 * Estimation rules (based on Claude tokenizer empirical data):
 * - ASCII (U+0000–U+007F): ~4 chars/token → 0.25 tokens/char
 * - Japanese/CJK (Hiragana, Katakana, Kanji, CJK Unified): ~1–2 tokens/char → 1.5 tokens/char (avg)
 * - Fullwidth/Halfwidth forms (U+FF00–U+FFEF): ~1 token/char
 * - Other non-ASCII: ~1 token/char
 *
 * No external dependencies.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x7f) {
      // ASCII: ~4 chars per token
      tokens += 0.25;
    } else if (
      (code >= 0x3000 && code <= 0x9fff) || // CJK punct, Hiragana, Katakana, CJK Unified Ideographs
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0xac00 && code <= 0xd7af)    // Korean Hangul (bonus coverage)
    ) {
      // Japanese/CJK: empirically ~1.5 tokens/char
      tokens += 1.5;
    } else if (code >= 0xff00 && code <= 0xffef) {
      // Fullwidth ASCII / Halfwidth Katakana
      tokens += 1.0;
    } else {
      // Other non-ASCII (emoji, Latin extended, etc.)
      tokens += 1.0;
    }
  }
  return Math.ceil(tokens);
}
