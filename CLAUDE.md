# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Easy Flow Agent は OpenClaw（AI エージェントプラットフォーム）向けのプラグイン群を提供するモノレポ。
eSTACK Inc. のプライベートリポジトリ。

## 開発コマンド

```bash
npm install          # 依存関係のインストール
npm test             # 全パッケージのテスト実行
npm run build        # 全パッケージのビルド
```

テストフレームワークは **vitest**（OpenClaw 本体の peerDependency 経由で提供）。
テストは `npx vitest run` または OpenClaw 側の設定に依存して実行される。

## リポジトリ構成

npm workspaces によるモノレポ構成（`packages/*`）。

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

### specs/

仕様書の管理ディレクトリ。spec-workflow MCP サーバーと連携。
現在 `pinecone-memory` の要件定義書・設計書が存在（Pinecone ベクトル DB によるメモリ最適化）。
