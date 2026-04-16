import type { ChunkMetadata } from "@easy-flow/pinecone-client";
import { describe, expect, it } from "vitest";
import { rerankChunks } from "./reranker.js";

function makeChunk(
  overrides: Partial<{
    id: string;
    text: string;
    score: number;
    sourceType: ChunkMetadata["sourceType"];
    createdAt: number;
  }> = {},
) {
  return {
    id: overrides.id ?? "chunk-1",
    text: overrides.text ?? "some text",
    score: overrides.score ?? 0.9,
    metadata: {
      agentId: "test-agent",
      sourceFile: "test.md",
      sourceType: overrides.sourceType ?? "memory_file",
      chunkIndex: 0,
      createdAt: overrides.createdAt ?? Date.now(),
    } satisfies ChunkMetadata,
  };
}

describe("rerankChunks", () => {
  describe("空配列", () => {
    it("空の入力で空の出力を返す", () => {
      expect(rerankChunks([])).toEqual([]);
    });
  });

  describe("sourceType 重み付け", () => {
    it("agents_rule > document > memory_file > session_turn > workflow_state の順にスコアが高い", () => {
      const now = Date.now();
      const chunks = [
        makeChunk({ id: "wf", sourceType: "workflow_state", score: 0.9, createdAt: now }),
        makeChunk({ id: "st", sourceType: "session_turn", score: 0.9, createdAt: now }),
        makeChunk({ id: "mf", sourceType: "memory_file", score: 0.9, createdAt: now }),
        makeChunk({ id: "doc", sourceType: "document", score: 0.9, createdAt: now }),
        makeChunk({ id: "ar", sourceType: "agents_rule", score: 0.9, createdAt: now }),
      ];

      // テキストが同一だと重複排除されるので、テキストを変える
      for (const c of chunks) c.text = `text-${c.id}`;

      const ranked = rerankChunks(chunks, now);

      expect(ranked[0].id).toBe("ar");
      expect(ranked[1].id).toBe("doc");
      expect(ranked[2].id).toBe("mf");
      expect(ranked[3].id).toBe("st");
      expect(ranked[4].id).toBe("wf");
    });
  });

  describe("鮮度スコア", () => {
    it("新しいチャンクが古いチャンクよりスコアが高い", () => {
      const now = Date.now();
      const recent = makeChunk({
        id: "recent",
        text: "recent text",
        score: 0.9,
        createdAt: now - 1 * 60 * 60 * 1000, // 1 hour ago
      });
      const old = makeChunk({
        id: "old",
        text: "old text",
        score: 0.9,
        createdAt: now - 6 * 24 * 60 * 60 * 1000, // 6 days ago
      });

      const ranked = rerankChunks([old, recent], now);

      expect(ranked[0].id).toBe("recent");
      expect(ranked[1].id).toBe("old");
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it("7 日以上前のチャンクは鮮度 0.0", () => {
      const now = Date.now();
      const chunk = makeChunk({
        id: "very-old",
        text: "very old",
        score: 0.9,
        createdAt: now - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      });

      const ranked = rerankChunks([chunk], now);

      // 最終スコア = 0.9 * 0.7 + 0.8 * 0.2 + 0.0 * 0.1 = 0.63 + 0.16 = 0.79
      expect(ranked[0].score).toBeCloseTo(0.79, 2);
    });
  });

  describe("重複排除", () => {
    it("同一テキストのチャンクが 1 つに絞られる", () => {
      const now = Date.now();
      const chunks = [
        makeChunk({ id: "dup-1", text: "duplicate text", score: 0.8, createdAt: now }),
        makeChunk({ id: "dup-2", text: "duplicate text", score: 0.95, createdAt: now }),
        makeChunk({ id: "unique", text: "unique text", score: 0.85, createdAt: now }),
      ];

      const ranked = rerankChunks(chunks, now);

      expect(ranked).toHaveLength(2);
      // 高スコアの方が残る
      const dupChunk = ranked.find((c) => c.text === "duplicate text");
      expect(dupChunk?.id).toBe("dup-2");
    });
  });

  describe("スコア計算", () => {
    it("最終スコア = ベクトル類似度 × 0.7 + sourceType 重み × 0.2 + 鮮度スコア × 0.1", () => {
      const now = Date.now();
      const chunk = makeChunk({
        id: "calc",
        text: "calc text",
        score: 0.9, // vector similarity
        sourceType: "agents_rule", // weight = 1.0
        createdAt: now, // freshness = 1.0
      });

      const ranked = rerankChunks([chunk], now);

      // 0.9 * 0.7 + 1.0 * 0.2 + 1.0 * 0.1 = 0.63 + 0.2 + 0.1 = 0.93
      expect(ranked[0].score).toBeCloseTo(0.93, 2);
      expect(ranked[0].originalScore).toBe(0.9);
    });
  });

  describe("ソート順", () => {
    it("最終スコア降順でソートされる", () => {
      const now = Date.now();
      const chunks = [
        makeChunk({ id: "low", text: "low", score: 0.7, createdAt: now }),
        makeChunk({ id: "high", text: "high", score: 0.99, createdAt: now }),
        makeChunk({ id: "mid", text: "mid", score: 0.85, createdAt: now }),
      ];

      const ranked = rerankChunks(chunks, now);

      expect(ranked[0].id).toBe("high");
      expect(ranked[1].id).toBe("mid");
      expect(ranked[2].id).toBe("low");
    });
  });
});
