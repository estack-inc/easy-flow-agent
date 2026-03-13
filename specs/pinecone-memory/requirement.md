# Pinecone Memory 統合 — 要件定義書

最終更新: 2026-03-14
担当: よりちかさん（基盤層） + メル（連携層・テスト）
リポジトリ: estack-inc/easy-flow-agent / Issue #3
関連 Epic: Token Optimizer（openclaw workspace #64）

---

## 背景・目的

### 現状の問題

OpenClaw の LegacyContextEngine はセッション開始時に全メモリファイルをロードする。
メルの場合、MEMORY.md 群の合計 276KB（414K〜552K トークン相当）が毎ターン注入される。
Year 1 で 100 契約を目指す事業計画において、このトークン消費量はコスト面・速度面で致命的。

### 解決策

Pinecone ベクトル DB に記憶を保存し、各ターンでクエリした**関連チャンクのみ**を注入する。
フルロードをやめることで、注入量を 2K〜10K トークン（95〜99% 削減）に圧縮する。

### ビジネス価値

| 指標 | 現状 | 目標 |
|------|------|------|
| 注入トークン数/ターン | 414K〜552K | 2K〜10K（-99%） |
| 記憶品質 | 劣化リスクあり（古い情報が埋もれる） | 関連度順取得で質向上 |
| スケール耐性 | 記憶が増えるほど悪化 | 一定（インデックスサイズ非依存） |

---

## スコープ

### IN スコープ

1. Pinecone 基盤層（`@easy-flow/pinecone-client`）
   - Pinecone SDK ラッパー
   - テキストのチャンク分割・埋め込み生成・Upsert
   - セマンティック検索（Query）
   - インデックス・ネームスペース管理
   - 既存メモリファイルの移行ツール

2. OpenClaw 連携層（`PineconeContextEngine`）
   - `ContextEngine` インターフェース実装
   - `ingest()` : ターン後の記憶保存（user / assistant 両方）
   - `assemble()` : 関連チャンク取得・注入
   - `compact()` : 古いセッション記憶の Pinecone 移行
   - `bootstrap()` : セッション初期化時の記憶ロード
   - `WorkflowContextEngine` との統合（デリゲート差し替え）

3. テスト・移行
   - 単体テスト（Vitest）
   - 統合テスト（Pinecone Starter）
   - 既存 MEMORY.md の Pinecone 移行 CLI

### OUT スコープ

- PII/Secret Hardening（#65）: 別 Epic
- ダッシュボード UI（#78）: 別 Epic
- マルチエージェント間の記憶共有: 将来対応

---

## 受け入れ基準

### 機能要件

| ID | 基準 |
|----|------|
| AC-1 | ターン後に user / assistant 両方のメッセージが Pinecone に保存される |
| AC-2 | `assemble()` で関連チャンクのみ（最大 20 件）が注入される |
| AC-3 | 注入トークン数が 10,000 以下に収まる |
| AC-4 | エージェント別にネームスペースが分離されている |
| AC-5 | 既存 MEMORY.md を Pinecone に移行できる（CLI ツール） |
| AC-6 | Pinecone 障害時にフォールバック（ファイル読み込み）が動作する |
| AC-7 | `WorkflowContextEngine` のデリゲートとして差し替え可能 |

### 非機能要件

| 項目 | 目標値 |
|------|--------|
| `assemble()` レイテンシ | 500ms 以下 |
| Pinecone 障害時の継続性 | フォールバックで動作継続 |
| テストカバレッジ | 90% 以上 |
| インデックス名 | `easy-flow-memory` |
| 埋め込みモデル | `multilingual-e5-large`（Pinecone Inference API 経由、動作確認済み） |
| 埋め込み生成 API | Pinecone Inference API（`pinecone.inference.embed()`）。OpenAI / Hugging Face は不使用 |
| ネームスペース | `agent:{agentId}` |

---

## ユーザーストーリー

### US-1: ターン後の記憶保存

```
よりちかさんがメルとやり取りした内容が、
次のセッションでも Pinecone から取得できる。
```

### US-2: 関連記憶の注入

```
メルが質問に答えるとき、
全記憶ではなく関連する記憶だけが自動的に選ばれてプロンプトに注入される。
```

### US-3: 既存記憶の移行

```
既存の MEMORY.md・memory/ 配下のファイルを
移行 CLI で Pinecone にインポートできる。
```

---

## 技術スタック

| 用途 | 選定 | 理由 |
|------|------|------|
| ベクトル DB | Pinecone Serverless | Starter プラン無料・日本語対応 |
| 埋め込みモデル | multilingual-e5-large | 日本語精度・1024 次元・Starter プラン動作確認済み |
| 埋め込み生成 | Pinecone Inference API | 追加 API キー不要・SDK 統合・ローカルモデル不要 |
| チャンク分割 | 1000 文字 / オーバーラップ 100 文字 | 日本語 1 文字 ≒ 0.5 トークンで 500 トークン相当 |
| SDK | @pinecone-database/pinecone v7.x | 公式・upsert は `{ records, namespace }` 形式 |

---

## 依存関係

| 依存 | 状態 |
|------|------|
| Workflow Controller (#63) | ✅ 完了 |
| UnifiedAgentState 型定義 (#55) | ✅ 完了 |
| Pinecone アカウント | ✅ API キー取得済み・動作確認済み |
| OpenClaw plugin-sdk ContextEngine 型 | ✅ 利用可能 |
