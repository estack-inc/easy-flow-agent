import type { FileRoutingRule, ModelRouterConfig } from "./config.js";

export type ClassificationResult = "light" | "default";

/** Attachment metadata from the before_model_resolve event (openclaw/openclaw#65754). */
export type AttachmentHint = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

/** Result of file-based routing. null means no file routing applies. */
export type FileRoutingResult = {
  model: string;
  provider: string;
  matchedRule: string;
} | null;

/**
 * Check if a MIME type matches a pattern.
 * Supports exact match and trailing wildcard (e.g. "image/*").
 */
export function matchMimePattern(mimeType: string, pattern: string): boolean {
  if (pattern === mimeType) return true;
  if (pattern.endsWith("*")) {
    // "image/*" → "image/", "application/vnd.ms-*" → "application/vnd.ms-"
    const prefix = pattern.slice(0, -1);
    return mimeType.startsWith(prefix);
  }
  return false;
}

/**
 * Determine file-based routing from attachment metadata.
 * Returns the first matching rule's model/provider, or null if no match.
 */
export function routeByAttachments(
  attachments: ReadonlyArray<AttachmentHint>,
  rules: FileRoutingRule[],
): FileRoutingResult {
  if (attachments.length === 0) return null;

  for (const rule of rules) {
    for (const attachment of attachments) {
      const mimeType = attachment.mimeType;
      if (mimeType && rule.mimePatterns.some((p) => matchMimePattern(mimeType, p))) {
        return { model: rule.model, provider: rule.provider, matchedRule: rule.label };
      }
    }
  }

  // Fallback: if any attachment exists but no MIME match, route by kind
  for (const rule of rules) {
    for (const attachment of attachments) {
      const kindToMime: Record<string, string> = {
        image: "image/unknown",
        video: "video/unknown",
        audio: "audio/unknown",
        document: "text/unknown",
      };
      const syntheticMime = kindToMime[attachment.kind];
      if (syntheticMime && rule.mimePatterns.some((p) => matchMimePattern(syntheticMime, p))) {
        return { model: rule.model, provider: rule.provider, matchedRule: `${rule.label}(kind)` };
      }
    }
  }

  return null;
}

/**
 * プロンプト内のメディアマーカー（`MEDIA: /path/to/file`）を検出し、
 * AttachmentHint に変換する。
 * OpenClaw のチャネル（LINE 等）は画像をプロンプト内 MEDIA マーカーとして渡すため、
 * before_model_resolve 時点では attachments が空でもプロンプトにメディア参照が含まれる。
 */
export function detectMediaInPrompt(prompt: string): AttachmentHint[] {
  const hints: AttachmentHint[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("MEDIA:")) continue;
    const afterColon = trimmed.slice(6).trim();
    const raw = afterColon.match(/^`([^`]+)`$/)?.[1] ?? afterColon;
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic|heif)$/i.test(lower)) {
      hints.push({ kind: "image", mimeType: inferMimeFromExt(lower) });
    } else if (/\.(mp4|mov|avi|webm|mkv|flv|wmv)$/i.test(lower)) {
      hints.push({ kind: "video", mimeType: inferMimeFromExt(lower) });
    } else if (/\.(mp3|wav|ogg|flac|aac|m4a|wma)$/i.test(lower)) {
      hints.push({ kind: "audio", mimeType: inferMimeFromExt(lower) });
    } else if (/\.(pdf|docx?|xlsx?|pptx?|csv|tsv|txt)$/i.test(lower)) {
      hints.push({ kind: "document", mimeType: inferMimeFromExt(lower) });
    } else {
      hints.push({ kind: "image" }); // MEDIA: without extension → assume image
    }
  }
  return hints;
}

function inferMimeFromExt(path: string): string | undefined {
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
  };
  return map[ext];
}

/**
 * ユーザープロンプトを分類し、軽量モデルで処理可能かを判定する。
 *
 * 判定優先順位:
 * 1. forceDefault パターンに一致 → "default"（Sonnet 維持）
 * 2. トークン数超過 → "default"
 * 3. preferLight パターンに一致 → "light"（Haiku）
 * 4. いずれにも該当しない → "default"
 */
export function classifyMessage(
  prompt: string,
  config: Required<ModelRouterConfig>,
): ClassificationResult {
  // 1. forceDefault パターンに一致する場合は Sonnet 維持
  const forceDefaultPatterns = config.patterns.forceDefault ?? [];
  if (forceDefaultPatterns.some((p) => prompt.toLowerCase().includes(p.toLowerCase()))) {
    return "default";
  }

  // 2. トークン数チェック（近似推定）
  // 日本語（ひらがな・カタカナ・漢字）は 1 文字 ≈ 1 トークン、
  // ASCII 英数字は 1 文字 ≈ 0.25 トークンで算出（PoC 段階の近似）
  const japaneseChars = (prompt.match(/[\u3040-\u9fff\uff00-\uffef]/g) ?? []).length;
  const otherChars = prompt.length - japaneseChars;
  const estimatedTokens = Math.ceil(japaneseChars + otherChars / 4);
  if (estimatedTokens > config.maxTokensForLight) {
    return "default";
  }

  // 3. preferLight パターンに一致する場合は Haiku
  const preferLightPatterns = config.patterns.preferLight ?? [];
  if (preferLightPatterns.some((p) => prompt.toLowerCase().includes(p.toLowerCase()))) {
    return "light";
  }

  // 4. デフォルトは Sonnet 維持
  return "default";
}
