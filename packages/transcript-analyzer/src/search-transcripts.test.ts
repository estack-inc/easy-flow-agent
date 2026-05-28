/**
 * search_transcripts の単体テスト
 *
 * - 空 query
 * - keyword 一致時に score > 0
 * - top_k 制限
 * - non-existing dir
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchTranscripts } from "./search-transcripts.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ta-search-"));
}

describe("searchTranscripts", () => {
  it("空 query は empty を返す", async () => {
    const res = await searchTranscripts({ query: "" }, { transcriptDir: "/tmp" });
    expect(res.chunks).toEqual([]);
    expect(res.total_found).toBe(0);
  });

  it("存在しない transcriptDir は empty を返す", async () => {
    const res = await searchTranscripts({ query: "hello" }, { transcriptDir: "/nonexistent/zzz" });
    expect(res.chunks).toEqual([]);
  });

  it("keyword が transcript に含まれていれば score > 0", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "meeting.txt"),
        "会議の決定事項は来月までに方針を確定する。\n".repeat(20),
      );
      const res = await searchTranscripts({ query: "決定事項" }, { transcriptDir: dir });
      expect(res.chunks.length).toBeGreaterThan(0);
      expect(res.chunks[0].score).toBeGreaterThan(0);
      expect(res.chunks[0].score).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("関係ない keyword なら matched なし", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "x.txt"), "hello world hello world".repeat(10));
      const res = await searchTranscripts(
        { query: "完全に関係ない token" },
        { transcriptDir: dir },
      );
      expect(res.chunks).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symlink 先の transcript は検索対象にしない", async () => {
    const dir = makeTmpDir();
    const outsideDir = makeTmpDir();
    try {
      const outside = join(outsideDir, "outside.txt");
      writeFileSync(outside, "leaked-unique-keyword ".repeat(20));
      try {
        symlinkSync(outside, join(dir, "linked.txt"));
      } catch {
        return;
      }
      writeFileSync(join(dir, "visible.txt"), "ordinary transcript text");

      const res = await searchTranscripts(
        { query: "leaked-unique-keyword" },
        { transcriptDir: dir },
      );

      expect(res.chunks).toHaveLength(0);
      expect(res.total_found).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("top_k で結果数を制限", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "big.txt"),
        Array.from({ length: 50 }, () => "Important keyword keyword keyword 内容").join("\n"),
      );
      const res = await searchTranscripts({ query: "keyword", top_k: 3 }, { transcriptDir: dir });
      expect(res.chunks.length).toBeLessThanOrEqual(3);
      expect(res.total_found).toBeGreaterThanOrEqual(res.chunks.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("top_k 未指定なら既定 10", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "big.txt"),
        Array.from({ length: 100 }, () => "kwd kwd kwd 内容").join("\n"),
      );
      const res = await searchTranscripts({ query: "kwd" }, { transcriptDir: dir });
      expect(res.chunks.length).toBeLessThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("score 降順で並ぶ", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "x.txt"), "abcabc abc abc abc abc kw kw kw kw\n".repeat(30));
      const res = await searchTranscripts({ query: "kw" }, { transcriptDir: dir });
      for (let i = 1; i < res.chunks.length; i++) {
        expect(res.chunks[i - 1].score).toBeGreaterThanOrEqual(res.chunks[i].score);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chunk_id は transcript_id ベース", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "x.txt"), "keyword ".repeat(200));
      const res = await searchTranscripts({ query: "keyword" }, { transcriptDir: dir });
      expect(res.chunks[0].chunk_id).toContain(res.chunks[0].transcript_id);
      expect(res.chunks[0].byte_range[0]).toBeGreaterThanOrEqual(0);
      expect(res.chunks[0].byte_range[1]).toBeGreaterThan(res.chunks[0].byte_range[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
