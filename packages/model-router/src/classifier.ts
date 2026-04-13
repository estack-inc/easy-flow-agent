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
 * プロンプト内のメディアマーカーを検出し、AttachmentHint に変換する。
 *
 * OpenClaw は LINE 等のチャネルから受信した画像を以下の形式でプロンプトに埋め込む:
 *   - `[media attached: /path/to/file (image/png)]`           — 単体添付
 *   - `[media attached 1/2: /path/to/file (image/png)]`       — 複数添付
 *   - `[media attached: /path (image/png) | https://url]`     — URL 付き
 *
 * before_model_resolve フック発火時点でプロンプトに含まれるため、
 * attachments が空でもプロンプトからメディア参照を検出できる。
 */
export function detectMediaInPrompt(prompt: string): AttachmentHint[] {
  const hints: AttachmentHint[] = [];

  // Pattern 1: [media attached: /path (type)] or [media attached N/M: /path (type)]
  const mediaAttachedRe = /\[media attached(?:\s+\d+\/\d+)?:\s+([^\s\]]+)(?:\s+\(([^)]+)\))?/g;
  for (const m of prompt.matchAll(mediaAttachedRe)) {
    const path = m[1] ?? "";
    // サマリー行 "[media attached: 2 files]" をスキップ
    if (/^\d+$/.test(path)) continue;
    const mimeType = m[2]?.trim();
    if (mimeType) {
      hints.push({ kind: classifyMimeKind(mimeType), mimeType });
    } else {
      // MIME 不明 → 拡張子から推定
      const inferred = inferMimeFromExt(path.toLowerCase());
      hints.push(
        inferred ? { kind: classifyMimeKind(inferred), mimeType: inferred } : { kind: "image" },
      );
    }
  }

  // Pattern 2: MEDIA: /path/to/file (legacy / future format)
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("MEDIA:")) continue;
    const afterColon = trimmed.slice(6).trim();
    const raw = afterColon.match(/^`([^`]+)`$/)?.[1] ?? afterColon;
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const inferred = inferMimeFromExt(lower);
    if (inferred) {
      hints.push({ kind: classifyMimeKind(inferred), mimeType: inferred });
    } else {
      hints.push({ kind: "image" }); // MEDIA: without extension → assume image
    }
  }

  return hints;
}

/** MIME type からメディア種別を分類する */
function classifyMimeKind(mimeType: string): AttachmentHint["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType.includes("document") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("presentation")
  ) {
    return "document";
  }
  return "other";
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
