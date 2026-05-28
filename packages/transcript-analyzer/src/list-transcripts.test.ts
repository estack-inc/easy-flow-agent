/**
 * list_transcripts の単体テスト
 *
 * - 空ディレクトリ
 * - 複数 transcript の sort（modified_at desc）
 * - summary_excerpt が redact 済み
 * - id が file_hash の prefix 16 文字
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSmallTranscript } from "./fixtures/index.js";
import { listTranscripts } from "./list-transcripts.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ta-list-"));
}

describe("listTranscripts", () => {
  it("ディレクトリが存在しないなら empty を返す", async () => {
    const res = await listTranscripts({ transcriptDir: "/nonexistent/path/zzz" });
    expect(res.transcripts).toEqual([]);
  });

  it("空ディレクトリは empty を返す", async () => {
    const dir = makeTmpDir();
    try {
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("複数 transcript が modified_at desc で並ぶ", async () => {
    const dir = makeTmpDir();
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      writeFileSync(a, "件名: A 会議\n本文 A");
      writeFileSync(b, "件名: B 会議\n本文 B");
      // mtime を明示的に差をつける
      const t1 = new Date("2026-05-01T00:00:00Z");
      const t2 = new Date("2026-05-10T00:00:00Z");
      utimesSync(a, t1, t1);
      utimesSync(b, t2, t2);
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts).toHaveLength(2);
      // b（より新しい）が先頭
      expect(res.transcripts[0].id.length).toBe(16);
      expect(res.transcripts[0].modified_at > res.transcripts[1].modified_at).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("隠しファイル / サブディレクトリは無視", async () => {
    const { mkdirSync } = await import("node:fs");
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".secret.txt"), "should be hidden");
      mkdirSync(join(dir, "subdir"));
      writeFileSync(join(dir, "subdir", "nested.txt"), "should be skipped");
      writeFileSync(join(dir, "visible.txt"), "件名: hello");
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summary_excerpt が redact 済み", async () => {
    const dir = makeTmpDir();
    try {
      const { filename, content } = makeSmallTranscript();
      writeFileSync(join(dir, filename), content);
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts).toHaveLength(1);
      const t = res.transcripts[0];
      expect(t.summary_excerpt_redacted).not.toBeNull();
      // 参加者・メールアドレス・電話は redact 済み
      expect(t.summary_excerpt_redacted).not.toContain("山田太郎");
      expect(t.summary_excerpt_redacted).not.toContain("090-1234-5678");
      // 80 文字以内
      expect((t.summary_excerpt_redacted as string).length).toBeLessThanOrEqual(80);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("id は file_hash の 16 文字 prefix", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "x.txt"), "abc");
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts[0].id).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("size_bytes は file の byte 数", async () => {
    const dir = makeTmpDir();
    try {
      const content = "hello world";
      writeFileSync(join(dir, "size.txt"), content);
      const res = await listTranscripts({ transcriptDir: dir });
      expect(res.transcripts[0].size_bytes).toBe(Buffer.byteLength(content, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
