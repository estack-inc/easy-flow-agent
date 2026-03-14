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
│           │     ├── EmbeddingService     ← Pinecone Inference API 経由
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
│   ├── embedding.ts          # 埋め込み生成（Pinecone Inference API）
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
  sourceFile: string;       // 元ファイルパス or "session:{sessionId}:{contentHash}"
                            // contentHash = sha256(sessionId:role:text) の先頭 16 文字
  sourceType: 'memory_file' | 'session_turn' | 'workflow_state';
  chunkIndex: number;
  createdAt: number;        // Unix timestamp (ms)
  turnId?: string;          // セッションターン識別子
  role?: 'user' | 'assistant'; // メッセージロール
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
  deleteBySource(agentId: string, sourceFile: string): Promise<void>;
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
  });

  // インデックスが存在しなければ作成
  async ensureIndex(): Promise<void>;

  // チャンクをアップサート（埋め込み生成 → Pinecone 保存）
  // SDK v7 形式: index.upsert({ records, namespace })
  // 同一 ID は上書き（冪等設計）
  async upsert(chunks: MemoryChunk[]): Promise<void>;

  // セマンティック検索
  async query(params: QueryParams): Promise<QueryResult[]>;

  // ID 指定削除
  async delete(ids: string[]): Promise<void>;

  // ソースファイル単位で削除（再取り込み前の古いチャンク削除に使用）
  async deleteBySource(agentId: string, sourceFile: string): Promise<void>;

  // ネームスペース全削除（エージェント削除時）
  async deleteNamespace(agentId: string): Promise<void>;
}
```

### EmbeddingService 実装仕様

```typescript
/**
 * 埋め込み生成は Pinecone Inference API を使用する。
 * - 使用モデル: multilingual-e5-large（1024 次元、Starter プラン対応確認済み）
 * - API: pinecone.inference.embed({ model, inputs, parameters })
 * - OpenAI / Hugging Face / ローカルモデルは使用しない
 *
 * バッチサイズ制限:
 * - Pinecone Inference API の上限: 96 件/リクエスト
 * - texts.length > BATCH_SIZE の場合、自動的に分割して順次処理する
 * - 移行 CLI など大量チャンクを処理する場合も安全に動作する
 */
export class EmbeddingService {
  private static readonly BATCH_SIZE = 96;

  // texts が 96 件を超える場合は自動バッチ分割して処理する
  async embed(texts: string[], inputType: 'passage' | 'query'): Promise<number[][]>;
}
```

### Chunker 実装仕様

```typescript
/**
 * テキスト分割方針:
 * - 単位: 文字数ベース（1000 文字 / オーバーラップ 100 文字）
 * - 根拠: 日本語 1 文字 ≒ 0.5 トークンのため、1000 文字 ≒ 500 トークン相当
 * - tiktoken 等の外部依存は持たない（シンプル・軽量を優先）
 */
export class TextChunker {
  constructor(config?: {
    chunkSize?: number;       // デフォルト: 1000（文字数）
    overlapSize?: number;     // デフォルト: 100（文字数）
  });

  chunk(params: {
    text: string;
    agentId: string;
    sourceFile: string;
    sourceType: ChunkMetadata['sourceType'];
    turnId?: string;
    role?: 'user' | 'assistant';
  }): MemoryChunk[];
}
```

### チャンク ID と冪等性

```
ID 形式: "{agentId}:{sourceFile}:{chunkIndex}"

冪等設計（意図的）:
- 同一ファイルを再チャンクした場合、同じ ID で上書きされる
- 再取り込み前に deleteBySource() で古いチャンクを全削除してから upsert する
- これにより古いチャンクが残留しない

再取り込みフロー:
1. deleteBySource(agentId, sourceFile)  // 既存チャンク削除
2. chunk(text, ...)                      // 再チャンク
3. upsert(chunks)                        // 新規保存
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
    tokenBudget?: number;         // デフォルト: 8000 トークン
    ingestRoles?: ('user' | 'assistant')[];  // デフォルト: ['user', 'assistant']
    compactAfterDays?: number;    // デフォルト: 7（設定可能）
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
- Pinecone 接続失敗 かつ fallbackAdapter 設定済み → fallbackAdapter.assemble() を呼ぶ
- Pinecone 接続失敗 かつ fallbackAdapter 未設定   → 空の systemPromptAddition を返す
- クエリ結果 0 件                                 → 空の systemPromptAddition を返す

注: fallbackAdapter は optional のため、未設定でも TypeError は発生しない
```

#### ingest() の処理フロー

```
1. AgentMessage を受け取る

2. ingestRoles に含まれる role のみ保存
   デフォルト: user / assistant 両方保存
   → ユーザーの質問文脈も検索対象にする

3. TextChunker でチャンク化

4. PineconeClient.upsert() で保存

5. エラー時はログ出力のみ（例外を伝播させない）
```

#### turnId の冪等設計

turnId は決定論的 hash で生成する（冪等設計）。
- 同一 sessionId + role + content → 常に同一 turnId
- 同じメッセージを 2 回 ingest しても Pinecone は上書き（重複エントリなし）
- 形式: sha256(sessionId + ":" + role + ":" + text) の先頭 16 文字
- 例: "${sessionId}:a1b2c3d4e5f6a7b8"

#### compact() の処理フロー

```
1. 対象セッションの古いターンを特定
   → 保存から compactAfterDays 日以上経過したもの（デフォルト: 7 日）
   → 7 日の根拠: 最近の会話は明示的に渡し、古い会話はベクトル検索で取得する境界線
   → コンストラクタ引数 compactAfterDays で変更可能

2. 対象ターンを Pinecone に全件 upsert する
   → 「未保存チェック」は行わない
   → 根拠: ingest() が毎ターン呼ばれる設計のため、compact() 時点では
     ほぼ全ターンが保存済みのはず。upsert は冪等（同一 ID は上書き）
     なので未保存チェックを省略しても安全かつシンプル
   → upsert 失敗時（1 件でも失敗）: compact() を即中断（ステップ 3 は実行しない）
     ログに compact 失敗を記録し、次回セッションで再試行する

3. upsert 完全成功時のみ: セッションファイルから古いターンを削除
   → upsert 失敗時にステップ 3 を実行すると、Pinecone 未保存のターンが
     セッションファイルからも削除され、記憶が永久に失われるため

注意: compact() は ingestRoles フィルターを適用しない。
readOldTurns() はセッションファイルの全ロールのメッセージを読み込むため、
ingestRoles でフィルタリングされたロール以外のメッセージも compact() の対象になる。
デフォルトの ingestRoles が ["user", "assistant"] である限り実用上は問題ないが、
カスタムロールを追加した場合は compact() の挙動に留意が必要。

4. delegate の compact() は呼ばない（Pinecone が代替）
```

#### bootstrap() の処理フロー

```
1. PineconeClient.ensureIndex() でインデックス確認

2. agentId の存在確認（ネームスペースにデータがあるか）

3. 自動移行はしない
   → MEMORY.md の Pinecone 移行は移行 CLI（Module 3）に委ねる
   → bootstrap() 内でユーザーへの確認プロンプトや環境変数フラグは持たない
   → 理由: bootstrap はセッション開始時の高速パスであり、移行処理を混在させると
     セッション開始が遅くなる。初回起動時の移行は CLI で明示的に実行する運用とする

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

**⚠️ Starter プランのインデックス数制限: 5 個まで**
- 本番: `easy-flow-memory` 1 つで全エージェントを管理（ネームスペースで分離）
- テスト用インデックスを作成する場合は使用後すぐに削除する
- 5 個を超える場合は Pinecone の有料プランへの移行を検討する

---

## エラーハンドリング

| エラー種別 | 対象メソッド | 対応 |
|-----------|------------|------|
| Pinecone API タイムアウト | assemble | 3 秒後にフォールバックアダプターへ委譲（未設定時は空を返す） |
| レート制限（429） | assemble / ingest / compact | Exponential backoff（100ms → 200ms → 400ms、最大 3 回リトライ） |
| 429 全リトライ失敗（assemble） | assemble | フォールバックアダプター経由で継続（未設定時は空を返す） |
| 429 全リトライ失敗（compact upsert） | compact | compact() を中断・セッションファイル削除は実行しない・次回再試行 |
| 埋め込み生成失敗 | ingest | スキップ + ログ（例外を伝播させない） |
| 429 全リトライ失敗 | ingest | スキップ + ログ（ingest の catch-all により例外を伝播させない） |
| upsert 失敗 | compact | compact() を中断・セッションファイル削除は実行しない・次回再試行 |
| インデックス未存在 | 全メソッド | 自動作成（ensureIndex） |

---

## タスク分割

### よりちかさん（Module 1: 15h）

| タスク | 工数 | 完了条件 |
|--------|------|---------|
| packages/pinecone-client 初期化・型定義 | 2h | tsconfig/package.json 設定完了 |
| TextChunker 実装 + テスト（文字数ベース） | 3h | チャンク分割・オーバーラップ正常動作 |
| EmbeddingService 実装（Pinecone Inference API） | 4h | テキスト → 1024 次元ベクトル生成 |
| PineconeClient.upsert / query 実装 | 4h | Pinecone への保存・検索が動作 |
| IndexManager（ensureIndex, deleteBySource, deleteNamespace） | 2h | 自動作成・削除・ソース別削除が動作 |

### メル（Module 2 + 3: 22h）

| タスク | 工数 | 完了条件 |
|--------|------|---------|
| packages/pinecone-context-engine 初期化 | 1h | 型定義・ディレクトリ構成 |
| assemble() 実装 + 単体テスト | 4h | クエリ→注入フロー動作 |
| ingest() / compact() 実装 + 単体テスト | 4h | user/assistant 両方保存・圧縮フロー動作 |
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
