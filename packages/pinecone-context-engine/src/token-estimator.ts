/**
 * Estimate token count from text.
 * Japanese: 1 character ~ 0.5 tokens.
 * ASCII: ~4 characters per token (standard GPT-style estimate).
 * No external dependencies.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 0x7f) {
      // Non-ASCII (Japanese, CJK, etc.): ~0.5 tokens per character
      tokens += 0.5;
    } else {
      // ASCII: ~0.25 tokens per character (4 chars/token)
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
