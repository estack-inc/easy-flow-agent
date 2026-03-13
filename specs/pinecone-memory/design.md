# Pinecone Memory 統合 — 設計書

最終更新: 2026-03-14

---

## アーキテクチャ概要

```
OpenClaw Runtime
│
├── WorkflowContextEngine          ← 既存（変更なし）
│     └── delegate: PineconeContextEngine  ← 新規（LegacyContextEngine を置き換え）
│           ├── PineconeClient             ← Module 1（よりちかさん実装）
│           │     ├── IndexManager
│           │     ├── EmbeddingService
│           │     └── VectorStore
│           └── FallbackAdapter            ← フォールバック（ファイル読み込み）
│
└── MigrationCLI                   ← 既存 MEMORY.md → Pinecone 移行ツール
```

---

## Module 1: Pinecone 基盤層（よりちかさん担当、15h）

### パッケージ構成

```
packages/pinecone-client/
├── src/
│   ├── index.ts              # public API
│   ├── client.ts             # PineconeClient（メインクラス）
│   ├── index-manager.ts      # インデックス管理
│   ├── embedding.ts          # 埋め込み生成
│   ├── chunker.ts            # テキストチャンク分割
│   ├── types.ts              # 型定義
│   └── *.test.ts             # Vitest テスト
├── package.json
└── tsconfig.json
```

### 型定義

```typescript
// チャンクの単位
export interface MemoryChunk {
  id: string;               // "{agentId}:{sourceFile}:{chunkIndex}"
  text: string;             // 元のテキスト
  embedding?: number[];     // 埋め込みベクトル（1024次元）
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  agentId: string;          // ネームスペース識別子
  sourceFile: string;       // 元ファイルパス or "session:{sessionId}"
  sourceType: 'memory_file' | 'session_turn' | 'workflow_state';
  chunkIndex: number;
  createdAt: number;        // Unix timestamp (ms)
  turnId?: string;          // セッションターン識別子
}

// クエリ結果
export interface QueryResult {
  chunk: MemoryChunk;
  score: number;            // コサイン類似度 (0-1)
}

// PineconeClient インターフェース
export interface IPineconeClient {
  upsert(chunks: MemoryChunk[]): Promise<void>;
  query(params: QueryParams): Promise<QueryResult[]>;
  delete(ids: string[]): Promise<void>;
  deleteNamespace(agentId: string): Promise<void>;
  ensureIndex(): Promise<void>;
}

export interface QueryParams {
  text: string;             // クエリテキスト（自然言語）
  agentId: string;          // ネームスペース
  topK?: number;            // 取得件数（デフォルト: 20）
  minScore?: number;        // 最低スコア（デフォルト: 0.7）
  filter?: Record<string, unknown>;  // メタデータフィルタ
}
```

### PineconeClient 実装仕様

```typescript
export class PineconeClient implements IPineconeClient {
  constructor(config: {
    apiKey: string;
    indexName: string;       // デフォルト: "easy-flow-memory"
    embeddingModel: string;  // デフォルト: "multilingual-e5-large"
  });

  // インデックスが存在しなければ作成
  async ensureIndex(): Promise<void>;

  // チャンクをアップサート（埋め込み生成 → Pinecone 保存）
  // SDK v7 形式: index.upsert({ records, namespace })
  async upsert(chunks: MemoryChunk[]): Promise<void>;

  // セマンティック検索
  async query(params: QueryParams): Promise<QueryResult[]>;

  // ID 指定削除
  async delete(ids: string[]): Promise<void>;

  // ネームスペース全削除（エージェント削除時）
  async deleteNamespace(agentId: string): Promise<void>;
}
```

### Chunker 実装仕様

```typescript
export class TextChunker {
  // テキストを 500 トークン単位・50 トークンオーバーラップで分割
  chunk(params: {
    text: string;
    agentId: string;
    sourceFile: string;
    sourceType: ChunkMetadata['sourceType'];
    turnId?: string;
  }): MemoryChunk[];
}
```

---

## Module 2: OpenClaw 連携層（メル担当、12h）

### パッケージ構成

```
packages/pinecone-context-engine/
├── src/
│   ├── index.ts
│   ├── pinecone-context-engine.ts   # ContextEngine 実装
│   ├── fallback-adapter.ts          # フォールバック
│   ├── token-estimator.ts           # トークン推定
│   └── *.test.ts
├── package.json
└── tsconfig.json
```

### PineconeContextEngine 実装仕様

```typescript
export class PineconeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'pinecone',
    name: 'Pinecone Context Engine',
    version: '1.0.0',
  };

  constructor(params: {
    pineconeClient: IPineconeClient;
    agentId: string;
    tokenBudget?: number;      // デフォルト: 8000 トークン
    fallbackAdapter?: ContextEngine;
  });
}
```

#### assemble() の処理フロー

```
1. 直近の会話メッセージからクエリテキストを構築
   → 直近 3 ターン分のテキストを結合

2. Pinecone にクエリ（topK=20, minScore=0.7）

3. スコア順に並び替え

4. tokenBudget（8000 トークン）内に収まるよう上位から選択

5. Markdown に整形して systemPromptAddition として返す

フォールバック条件:
- Pinecone 接続失敗 → fallbackAdapter.assemble() を呼ぶ
- クエリ結果 0 件 → 空の systemPromptAddition
```

#### ingest() の処理フロー

```
1. AgentMessage を受け取る

2. role が 'assistant' の場合のみ保存（userメッセージは任意）

3. TextChunker でチャンク化

4. PineconeClient.upsert() で保存

5. エラー時はログ出力のみ（例外を伝播させない）
```

#### compact() の処理フロー

```
1. 対象セッションの古いターン（7日以前）を特定

2. 各ターンを Pinecone に upsert（未保存のもの）

3. セッションファイルから古いターンを削除

4. delegate の compact() は呼ばない（Pinecone が代替）
```

#### bootstrap() の処理フロー

```
1. PineconeClient.ensureIndex() でインデックス確認

2. agentId の存在確認（ネームスペースにデータがあるか）

3. 初回セッション → MEMORY.md があれば移行処理を呼ぶ（任意）

4. { bootstrapped: true } を返す
```

### WorkflowContextEngine との統合

```typescript
// 既存コード（変更なし）
const workflowEngine = new WorkflowContextEngine({
  delegate: pineconeEngine,  // ← LegacyContextEngine から差し替え
  agentDir,
  activeWorkflowId,
});
```

---

## Module 3: テスト・移行（メル主担当、10h）

### テスト方針

| 対象 | テスト種別 | ツール |
|------|----------|--------|
| TextChunker | 単体 | Vitest（モック不要） |
| PineconeClient | 統合 | Vitest + 実 Pinecone Starter |
| PineconeContextEngine | 単体 | Vitest + PineconeClient モック |
| フォールバック動作 | 単体 | Vitest + 接続失敗シミュレーション |
| 移行 CLI | 統合 | Vitest + ファイル読み込み |

### 移行 CLI 仕様

```bash
# MEMORY.md 群を Pinecone に移行
npx easy-flow migrate-memory \
  --agent-id mell \
  --source ~/.openclaw/workspace/MEMORY.md \
  --source ~/.openclaw/workspace/memory/ \
  --dry-run    # 実行前に確認

# 実行
npx easy-flow migrate-memory \
  --agent-id mell \
  --source ~/.openclaw/workspace/MEMORY.md \
  --source ~/.openclaw/workspace/memory/
```

---

## インデックス設計

```
インデックス名: easy-flow-memory
次元数: 1024（multilingual-e5-large）
メトリクス: cosine
タイプ: Serverless（aws us-east-1）

ネームスペース:
  agent:mell              ← メル本番
  agent:mell-estack       ← estack-mell 検証環境
  agent:{clientId}        ← クライアント別
```

---

## エラーハンドリング

| エラー種別 | 対応 |
|-----------|------|
| Pinecone API タイムアウト | 3 秒後にフォールバック |
| レート制限（429） | 100ms wait → 1 回リトライ |
| 埋め込み生成失敗 | スキップ（ingest のみ）+ ログ |
| インデックス未存在 | 自動作成（ensureIndex） |

---

## タスク分割

### よりちかさん（Module 1: 15h）

| タスク | 工数 | 完了条件 |
|--------|------|---------|
| packages/pinecone-client 初期化・型定義 | 2h | tsconfig/package.json 設定完了 |
| TextChunker 実装 + テスト | 3h | チャンク分割・オーバーラップ正常動作 |
| EmbeddingService 実装（multilingual-e5-large） | 4h | テキスト → 1024 次元ベクトル生成 |
| PineconeClient.upsert / query 実装 | 4h | Pinecone への保存・検索が動作 |
| IndexManager（ensureIndex, deleteNamespace） | 2h | 自動作成・削除が動作 |

### メル（Module 2 + 3: 22h）

| タスク | 工数 | 完了条件 |
|--------|------|---------|
| packages/pinecone-context-engine 初期化 | 1h | 型定義・ディレクトリ構成 |
| assemble() 実装 + 単体テスト | 4h | クエリ→注入フロー動作 |
| ingest() / compact() 実装 + 単体テスト | 4h | 保存・圧縮フロー動作 |
| bootstrap() + フォールバック実装 | 3h | 障害時継続確認 |
| WorkflowContextEngine 統合 | 2h | 差し替えで既存テスト全通過 |
| 移行 CLI 実装 | 4h | MEMORY.md の Pinecone 移行成功 |
| 統合テスト + ドキュメント | 4h | 90% カバレッジ達成 |

---

## 実装順序（並行実装）

```
Week 1（3/13〜3/17）
  よりちかさん: Module 1 全実装
  メル: Module 2 設計・型定義・assemble() 実装開始

Week 2（3/18〜3/24）
  よりちかさん: Module 1 完成 → PR レビュー
  メル: ingest/compact/bootstrap 実装 + フォールバック

Week 3（3/25〜3/31）
  メル: 統合テスト・移行 CLI・本番適用
  よりちかさん: レビュー・本番確認
```
