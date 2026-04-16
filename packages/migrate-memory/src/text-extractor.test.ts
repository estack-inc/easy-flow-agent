import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractText, isGoogleDocsUrl, isSupportedInput, isUrl } from "./text-extractor.js";

describe("isUrl", () => {
  it("should detect http URLs", () => {
    expect(isUrl("http://example.com")).toBe(true);
    expect(isUrl("https://example.com/page")).toBe(true);
  });

  it("should reject non-URLs", () => {
    expect(isUrl("file.txt")).toBe(false);
    expect(isUrl("/path/to/file.md")).toBe(false);
  });
});

describe("isGoogleDocsUrl", () => {
  it("should detect Google Docs URLs", () => {
    expect(isGoogleDocsUrl("https://docs.google.com/document/d/abc123/edit")).toBe(true);
    expect(isGoogleDocsUrl("https://docs.google.com/spreadsheets/d/abc123/edit")).toBe(true);
    expect(isGoogleDocsUrl("https://docs.google.com/presentation/d/abc123/edit")).toBe(true);
  });

  it("should reject non-Google Docs URLs", () => {
    expect(isGoogleDocsUrl("https://example.com")).toBe(false);
  });
});

describe("isSupportedInput", () => {
  it("should accept text/markdown files", () => {
    expect(isSupportedInput("file.txt")).toBe(true);
    expect(isSupportedInput("file.md")).toBe(true);
  });

  it("should accept office files", () => {
    expect(isSupportedInput("file.docx")).toBe(true);
    expect(isSupportedInput("file.xlsx")).toBe(true);
    expect(isSupportedInput("file.pptx")).toBe(true);
  });

  it("should accept PDF", () => {
    expect(isSupportedInput("file.pdf")).toBe(true);
  });

  it("should accept URLs", () => {
    expect(isSupportedInput("https://example.com")).toBe(true);
  });

  it("should reject unsupported formats", () => {
    expect(isSupportedInput("file.csv")).toBe(false);
    expect(isSupportedInput("file.jpg")).toBe(false);
  });
});

describe("extractText", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extractor-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("should extract text from .txt file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "hello world");
    expect(await extractText(filePath)).toBe("hello world");
  });

  it("should extract text from .md file", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "# Title\n\nContent");
    expect(await extractText(filePath)).toBe("# Title\n\nContent");
  });

  it("should throw for unsupported file type", async () => {
    const filePath = join(tmpDir, "test.csv");
    await writeFile(filePath, "a,b,c");
    await expect(extractText(filePath)).rejects.toThrow("Unsupported file type: .csv");
  });

  it("should extract text from URL", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response("<html><body><main><p>Page content</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await extractText("https://example.com/page");
    expect(text).toContain("Page content");

    vi.unstubAllGlobals();
  });

  it("should convert Google Docs URL to export URL", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response("Document text content", {
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await extractText("https://docs.google.com/document/d/abc123/edit");
    expect(text).toBe("Document text content");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://docs.google.com/document/d/abc123/export?format=txt",
      expect.any(Object),
    );

    vi.unstubAllGlobals();
  });

  it("should throw on fetch failure", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(extractText("https://example.com/missing")).rejects.toThrow("404");

    vi.unstubAllGlobals();
  });
});
