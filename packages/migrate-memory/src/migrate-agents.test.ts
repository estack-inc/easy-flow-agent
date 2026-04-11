import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IPineconeClient, MemoryChunk } from "@easy-flow/pinecone-client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AgentsMigrator, estimateTokens, parseMarkdownSections } from "./migrate-agents.js";

function createMockClient(): IPineconeClient & {
  [K in keyof IPineconeClient]: Mock;
} {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  } as IPineconeClient & { [K in keyof IPineconeClient]: Mock };
}

describe("parseMarkdownSections", () => {
  it("## 見出しで分割する", () => {
    const text = `## セクション 1
内容 1

## セクション 2
内容 2`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("## セクション 1");
    expect(sections[0].text).toContain("内容 1");
    expect(sections[1].heading).toBe("## セクション 2");
    expect(sections[1].text).toContain("内容 2");
  });

  it("### 見出しで分割する", () => {
    const text = `### サブセクション A
内容 A

### サブセクション B
内容 B`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("### サブセクション A");
    expect(sections[1].heading).toBe("### サブセクション B");
  });

  it("#### 以下の見出しは親セクションに含める", () => {
    const text = `## 親セクション
親の内容

#### 深い見出し
深い内容

##### さらに深い
さらに深い内容`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("## 親セクション");
    expect(sections[0].text).toContain("#### 深い見出し");
    expect(sections[0].text).toContain("深い内容");
    expect(sections[0].text).toContain("##### さらに深い");
  });

  it("最初の ## / ### より前のテキストをプリアンブルとして扱う", () => {
    const text = `# タイトル
導入テキスト

## セクション 1
内容 1`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("");
    expect(sections[0].text).toContain("# タイトル");
    expect(sections[0].text).toContain("導入テキスト");
    expect(sections[1].heading).toBe("## セクション 1");
  });

  it("空のテキストでは空配列を返す", () => {
    expect(parseMarkdownSections("")).toHaveLength(0);
    expect(parseMarkdownSections("   ")).toHaveLength(0);
  });

  it("見出しなしのテキストは 1 チャンクになる", () => {
    const text = "見出しのないプレーンテキスト\n複数行ある";

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("");
    expect(sections[0].text).toContain("見出しのないプレーンテキスト");
  });

  it("## と ### が混在するドキュメントを正しく分割する", () => {
    const text = `## 大セクション
大の内容

### サブセクション
サブの内容

## 次の大セクション
次の内容`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("## 大セクション");
    expect(sections[1].heading).toBe("### サブセクション");
    expect(sections[2].heading).toBe("## 次の大セクション");
  });

  it("見出しのみ（本文なし）のセクションも含める", () => {
    const text = `## 見出しのみ

## 次のセクション
内容あり`;

    const sections = parseMarkdownSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("## 見出しのみ");
    expect(sections[1].heading).toBe("## 次のセクション");
  });
});

describe("estimateTokens", () => {
  it("ASCII テキストは ~4 chars/token で推定する", () => {
    const text = "Hello World"; // 11 ASCII chars → ceil(11 * 0.25) = 3
    expect(estimateTokens(text)).toBe(3);
  });

  it("空文字列は 0 を返す", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("日本語テキストは ~1.5 tokens/char で推定する", () => {
    const text = "日本語テスト"; // 6 CJK chars → ceil(6 * 1.5) = 9
    expect(estimateTokens(text)).toBe(9);
  });

  it("日本語と ASCII の混在テキストを正しく推定する", () => {
    const text = "Hello日本語"; // 5 ASCII + 3 CJK → ceil(5*0.25 + 3*1.5) = ceil(5.75) = 6
    expect(estimateTokens(text)).toBe(6);
  });
});

describe("AgentsMigrator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run モードでは upsert も deleteBySource も呼ばない", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
      dryRun: true,
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## ルール 1\n内容 1\n\n## ルール 2\n内容 2", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.chunks).toBe(2);
    expect(result.upsertedChunks).toBe(0);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("通常モードでは deleteBySource → upsert の順で呼ぶ", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
      dryRun: false,
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## ルール 1\n内容 1\n\n## ルール 2\n内容 2", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.chunks).toBe(2);
    expect(result.upsertedChunks).toBe(2);
    expect(client.deleteBySource).toHaveBeenCalledWith("mel", "AGENTS.md");
    expect(client.upsert).toHaveBeenCalledOnce();

    // deleteBySource が upsert より先に呼ばれていることを確認
    const deleteOrder = client.deleteBySource.mock.invocationCallOrder[0];
    const upsertOrder = client.upsert.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(upsertOrder);
  });

  it("メタデータに agents_rule と agentId を正しく設定する", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## テストルール\nルール内容", "utf-8");

    await migrator.migrate(file);

    const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
    expect(chunks[0].metadata.sourceType).toBe("agents_rule");
    expect(chunks[0].metadata.agentId).toBe("mel");
    expect(chunks[0].metadata.sourceFile).toBe("AGENTS.md");
    expect(chunks[0].metadata.createdAt).toBeTypeOf("number");
    expect(chunks[0].metadata.chunkIndex).toBe(0);
  });

  it("チャンク ID が正しい形式で生成される", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## セクション 1\n内容 1\n\n## セクション 2\n内容 2", "utf-8");

    await migrator.migrate(file);

    const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
    expect(chunks[0].id).toBe("mel:AGENTS.md:0");
    expect(chunks[1].id).toBe("mel:AGENTS.md:1");
  });

  it("空ファイルでは 0 チャンクを返す", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.chunks).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("空白のみのファイルでは 0 チャンクを返す", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "   \n\n  ", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.chunks).toBe(0);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("見出しなしファイルは 1 チャンクになる", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "見出しのないルール記述\n複数行に渡る内容", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.chunks).toBe(1);
    expect(result.upsertedChunks).toBe(1);
  });

  it("sections に見出しとトークン数が含まれる", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
      dryRun: true,
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## コミュニケーション\nルール内容\n\n## レビュー\n基準内容", "utf-8");

    const result = await migrator.migrate(file);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].heading).toBe("## コミュニケーション");
    expect(result.sections[0].tokens).toBeGreaterThan(0);
    expect(result.sections[1].heading).toBe("## レビュー");
  });

  it("totalTokens がすべてのセクションのトークン数の合計になる", async () => {
    const client = createMockClient();
    const migrator = new AgentsMigrator({
      pineconeClient: client,
      agentId: "mel",
      dryRun: true,
    });

    const file = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(file, "## セクション A\n内容 A\n\n## セクション B\n内容 B", "utf-8");

    const result = await migrator.migrate(file);

    const sumTokens = result.sections.reduce((sum, s) => sum + s.tokens, 0);
    expect(result.totalTokens).toBe(sumTokens);
  });
});
