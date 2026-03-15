# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Easy Flow Agent は OpenClaw（AI エージェントプラットフォーム）向けのプラグイン群を提供するモノレポ。
eSTACK Inc. のプライベートリポジトリ。

## 開発コマンド

```bash
npm install          # 依存関係のインストール
npm test             # 全パッケージのテスト実行
npm run lint         # Biome による Lint チェック
npm run lint:fix     # Lint + Format 自動修正
npm run format       # コードフォーマットのみ
```

テストフレームワークは **vitest**（各パッケージの `devDependencies` で管理）。
Lint / Format は **Biome**（ルートの `biome.json` で統一設定）。
ビルドは不要（ソース直接参照パターン: `exports` → `./src/index.ts`）。
`migrate-memory` のみ `dist/` へのビルドあり（CLI バイナリ提供のため）。

## リポジトリ構成

npm workspaces によるモノレポ構成（`packages/*`）。

### packages/pinecone-client

Pinecone ベクトル DB の低レベルクライアントラッパー。

- `PineconeClient` — upsert / query / delete の統合インターフェース
- `TextChunker` — テキスト分割
- `EmbeddingService` — Pinecone Inference API によるベクトル生成
- `IndexManager` — インデックスの自動作成・キャッシュ
- 依存: `@pinecone-database/pinecone` ^7.0.0

### packages/pinecone-context-engine

Pinecone を使った OpenClaw ContextEngine 実装。セマンティック検索によるメモリ取得・蓄積を提供。

- `PineconeContextEngine` — `assemble()` で関連記憶をプロンプトに注入、`ingest()` でターンを Pinecone に蓄積
- `FallbackContextEngine` / `EmptyFallbackContextEngine` — Pinecone 接続不可時のフォールバック
- `estimateTokens` — トークン数推定ユーティリティ
- 依存: `@easy-flow/pinecone-client`、peerDep: `openclaw >=2026.3.7`（optional）

### packages/openclaw-pinecone-plugin

PineconeContextEngine を OpenClaw の context-engine プラグインスロットに登録する薄いラッパー。

- `register(api)` → `api.registerContextEngine("pinecone-memory", factory)`
- API キーは `pluginConfig.apiKey` または `PINECONE_API_KEY` 環境変数から取得
- キー未設定時は warn ログを出してプラグインを無効化
- 依存: `@easy-flow/pinecone-client`、`@easy-flow/pinecone-context-engine`

### packages/workflow-controller

OpenClaw プラグインとして動作するワークフロー実行制御エンジン。

**2 つの統合ポイント:**
1. **ContextEngine**（`api.registerContextEngine`）— `assemble()` の `systemPromptAddition` 経由でワークフロー状態を LLM プロンプトに動的注入
2. **Tool 群**（`api.registerTool`）— AI エージェントがワークフローを操作するための 5 つのツール（`workflow_create`, `workflow_advance`, `workflow_block`, `workflow_status`, `workflow_update_context`）

**レイヤー構成:**
- `index.ts` — プラグインエントリポイント。OpenClaw の `registerContextEngine` / `registerTool` を呼び出す
- `src/context-engine.ts` — `WorkflowContextEngine`: LegacyContextEngine をラップし、ワークフロー Markdown を `systemPromptAddition` として注入
- `src/store.ts` — ファイルベースの永続化ストア（`~/.openclaw/agents/<agentId>/workflow/<id>.json`）。atomic write（tmp + rename）
- `src/tools.ts` — 5 つのワークフロー操作ツールのファクトリ
- `src/types.ts` — `WorkflowState`（内部永続化）と `UnifiedAgentState`（外部公開インターフェース）の型定義
- `src/noop-delegate.ts` — ContextEngine 初期化前のフォールバック delegate

**設計上の制約:**
- `WorkflowState` は JSON 永続化互換（`Set` 不使用、`string[]` で代替）
- OpenClaw の `SessionEntry` とは分離し、プラグイン独自ストレージで管理
- `peerDependencies: openclaw >=2026.3.7`（optional）
- ESM モジュール（`"type": "module"`、import パスに `.js` 拡張子が必要）

### packages/migrate-memory

MEMORY.md ファイルを Pinecone ベクトル DB へ移行する CLI ツール。

- `Migrator` クラス — マークダウンをチャンク分割して Pinecone に upsert
- CLI: `npx easy-flow migrate` で実行
- 依存: `@easy-flow/pinecone-client`
- このパッケージのみ `dist/` ビルドあり（CLI バイナリ提供のため）

### specs/

仕様書の管理ディレクトリ。spec-workflow MCP サーバーと連携。
現在 `pinecone-memory` の要件定義書・設計書が存在（Pinecone ベクトル DB によるメモリ最適化）。

## 共通の設計規約

- ESM モジュール（全パッケージ `"type": "module"`）
- ソース直接参照パターン（`exports: { ".": "./src/index.ts" }`）— ビルド不要で開発効率を優先
- `peerDependencies: openclaw`（optional）— OpenClaw なしでもテスト可能
- テストは各パッケージの `devDependencies` で vitest を管理
