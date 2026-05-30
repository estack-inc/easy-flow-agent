/**
 * transcript-analyzer 型定義
 *
 * contracts.md §1.3「tool 戻り値 / 引数の型定義」を正本として実装する。
 * 本ファイルでは shape を再宣言するが、契約の変更は必ず contracts.md を
 * 先に更新し、本ファイルを追従させる。
 */
export interface TranscriptMetadata {
    /** file_hash の prefix（16 文字程度） */
    id: string;
    size_bytes: number;
    /** ISO 8601 */
    modified_at: string;
    /** participant / meeting_name 等の生情報は redact 済み */
    summary_excerpt_redacted: string | null;
}
export interface ListTranscriptsResponse {
    transcripts: TranscriptMetadata[];
}
export interface SearchTranscriptsRequest {
    query: string;
    /** 既定 10 */
    top_k?: number;
}
export interface TranscriptChunk {
    transcript_id: string;
    chunk_id: string;
    byte_range: [number, number];
    /** 0.0 - 1.0 */
    score: number;
}
export interface SearchTranscriptsResponse {
    chunks: TranscriptChunk[];
    total_found: number;
}
export interface AnalyzeTranscriptRequest {
    transcript_id: string;
    query: string;
}
export type CacheStatus = "hit" | "miss" | "fallback_chunk" | "fallback_model" | "failure" | "quota_exceeded";
export type AnswerScope = "explicit" | "inferred" | "not_found";
export type RedactionType = "participant" | "meeting_name" | "email" | "phone" | "address" | "credential";
export interface Redaction {
    type: RedactionType;
    original_length: number;
    /** ISO 8601 */
    redacted_at: string;
}
export interface Citation {
    transcript_id: string;
    chunk_id: string;
    byte_range: [number, number];
    /** 最大 500 文字、redact 済み */
    excerpt: string;
}
export interface AnalyzeTranscriptResponse {
    answer: string;
    citations: Citation[];
    /** chunk_id の列挙 */
    used_chunks: string[];
    redactions: Redaction[];
    answer_scope: AnswerScope;
    /** 0.0 - 1.0 */
    confidence: number;
    confidence_reason: string;
    /** 例：'gemini-2.5-flash' */
    model: string;
    cache_status: CacheStatus;
    /** 例：'v1' */
    prompt_version: string;
    warnings: string[];
    open_questions: string[];
}
export interface CacheKey {
    /** SHA256 hex */
    file_hash: string;
    /** SHA256(normalize(query)) hex */
    query_hash: string;
    /** 'gemini-2.5-flash' 等 */
    model: string;
    /** 'v1' 等 */
    prompt_version: string;
}
export interface CacheEntry {
    /** sha256(CacheKey の concat) */
    key: string;
    response: AnalyzeTranscriptResponse;
    /** epoch ms */
    created_at: number;
    /** epoch ms */
    expires_at: number;
}
export interface TranscriptProvenance {
    /** file_hash の prefix */
    transcript_id: string;
    /** SHA256 hex */
    file_hash: string;
    /** 例：'/data/workspace/zoom_transcribe/2026-04-15.txt' */
    source_path: string;
    chunk_id?: string;
    byte_range?: [number, number];
}
export interface TranscriptAnalyzerConfig {
    transcriptDir?: string;
    model?: string;
    fallbackModel?: string;
    cacheBackend?: "file";
    cacheTtlDays?: number;
    cacheFailureTtlMinutes?: number;
    maxAnalyzePerSession?: number;
    maxAnalyzePerFilePerDay?: number;
    monthlySpendCapUsd?: number;
    promptVersion?: string;
    geminiTimeoutSec?: number;
    enabled?: boolean;
}
export interface ResolvedConfig {
    transcriptDir: string;
    model: string;
    fallbackModel: string;
    cacheBackend: "file";
    cacheTtlDays: number;
    cacheFailureTtlMinutes: number;
    maxAnalyzePerSession: number;
    maxAnalyzePerFilePerDay: number;
    monthlySpendCapUsd: number;
    promptVersion: string;
    geminiTimeoutSec: number;
    enabled: boolean;
}
export type GeminiFailureKind = "429" | "500" | "timeout" | "auth_missing";
/** fallbackModel として許可される model 名の prefix。Sonnet / claude 等を含まないことを保証 */
export declare const ALLOWED_FALLBACK_MODEL_PREFIXES: string[];
/** 禁止 model 名の token（runtime check 用） */
export declare const FORBIDDEN_MODEL_TOKENS: string[];
/**
 * 禁止 model 名が混入していないかを検査する。
 * 違反時は throw する（fallback 経路に sonnet が紛れ込んだら絶対に呼ばせない）。
 */
export declare function assertNotForbiddenModel(modelName: string): void;
/**
 * model が明示的に Gemini 系であることを検査する。
 */
export declare function assertAllowedGeminiModel(modelName: string): void;
