/**
 * 多形式テキスト抽出モジュール
 *
 * 対応形式:
 *   - テキスト/Markdown (.txt, .md, .markdown, .text)
 *   - Word (.docx)
 *   - Excel (.xlsx)
 *   - PowerPoint (.pptx)
 *   - PDF (.pdf)
 *   - URL (HTML ページ)
 *   - Google Docs (公開ドキュメント URL)
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".text"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const ALL_SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, ".pdf"]);

const GOOGLE_DOCS_PATTERN = /^https:\/\/docs\.google\.com\/document\/d\/([^/]+)/;
const GOOGLE_SHEETS_PATTERN = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)/;
const GOOGLE_SLIDES_PATTERN = /^https:\/\/docs\.google\.com\/presentation\/d\/([^/]+)/;

export function isUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

export function isGoogleDocsUrl(url: string): boolean {
  return (
    GOOGLE_DOCS_PATTERN.test(url) ||
    GOOGLE_SHEETS_PATTERN.test(url) ||
    GOOGLE_SLIDES_PATTERN.test(url)
  );
}

export function isSupportedInput(input: string): boolean {
  if (isUrl(input)) return true;
  return ALL_SUPPORTED_EXTENSIONS.has(extname(input).toLowerCase());
}

/** テキスト/Markdown ファイルからテキスト抽出 */
async function extractPlainText(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

/** Word (.docx) からテキスト抽出 */
async function extractDocx(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.extractRawText({ path: filePath });
  return result.value;
}

/** Excel (.xlsx) からテキスト抽出 */
async function extractXlsx(filePath: string): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.readFile(filePath);
  const lines: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    lines.push(`## ${sheetName}`);
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    lines.push(csv);
    lines.push("");
  }

  return lines.join("\n");
}

/** PowerPoint (.pptx) からテキスト抽出 */
async function extractPptx(filePath: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const data = await readFile(filePath);
  const zip = await JSZip.loadAsync(data);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    });

  const texts: string[] = [];

  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text");
    // Extract text from <a:t> tags in the slide XML
    const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
    if (matches) {
      const slideText = matches.map((m) => m.replace(/<\/?a:t>/g, "")).join(" ");
      texts.push(slideText);
    }
  }

  return texts.join("\n\n");
}

/** PDF からテキスト抽出 */
async function extractPdf(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { PDFParse } = await import("pdf-parse");
  const data = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  const result = await parser.getText();
  return result.text;
}

/** URL からテキスト抽出（HTML → プレーンテキスト） */
async function extractUrl(url: string): Promise<string> {
  // Google Docs の場合は export URL に変換
  const fetchUrl = toGoogleExportUrl(url) ?? url;

  const res = await fetch(fetchUrl, {
    headers: { "User-Agent": "EasyFlow-RAG-Ingester/1.0" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  // Google Docs export returns plain text
  if (contentType.includes("text/plain")) {
    return body;
  }

  // HTML → text extraction
  const cheerio = await import("cheerio");
  const $ = cheerio.load(body);

  // Remove non-content elements
  $("script, style, nav, header, footer, aside, noscript").remove();

  // Get text from main content or body
  const mainContent = $("main, article, [role=main]").first();
  const text = mainContent.length > 0 ? mainContent.text() : $("body").text();

  // Clean up whitespace
  return text.replace(/\s+/g, " ").trim();
}

/** Google Docs/Sheets/Slides URL を export URL に変換 */
function toGoogleExportUrl(url: string): string | null {
  const docsMatch = url.match(GOOGLE_DOCS_PATTERN);
  if (docsMatch) {
    return `https://docs.google.com/document/d/${docsMatch[1]}/export?format=txt`;
  }

  const sheetsMatch = url.match(GOOGLE_SHEETS_PATTERN);
  if (sheetsMatch) {
    return `https://docs.google.com/spreadsheets/d/${sheetsMatch[1]}/export?format=csv`;
  }

  const slidesMatch = url.match(GOOGLE_SLIDES_PATTERN);
  if (slidesMatch) {
    return `https://docs.google.com/presentation/d/${slidesMatch[1]}/export?format=txt`;
  }

  return null;
}

/**
 * ファイルパスまたは URL からテキストを抽出する
 */
export async function extractText(input: string): Promise<string> {
  if (isUrl(input)) {
    return extractUrl(input);
  }

  const ext = extname(input).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) return extractPlainText(input);
  if (ext === ".docx") return extractDocx(input);
  if (ext === ".xlsx") return extractXlsx(input);
  if (ext === ".pptx") return extractPptx(input);
  if (ext === ".pdf") return extractPdf(input);

  throw new Error(
    `Unsupported file type: ${ext}. Supported: ${[...ALL_SUPPORTED_EXTENSIONS].join(", ")}, URL`,
  );
}
