# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本 CLAUDE.md は **(1) 共通ベースライン**（Easy Flow 各リポジトリ共通のガードレール）と **(2) リポジトリ固有の設計・運用ルール**（ESM / ソース直接参照 / peer dep / Pinecone 永続化互換 等）の 2 層で構成する。

## 共通ベースライン

> 対象: `estack-inc` 配下の全リポジトリ（`openclaw-templates` / `openclaw-clients` を含む）
> 対象外: 外部 org の `openclaw/openclaw`（上流リポジトリ。本ベースラインの管理範囲外）
> 目的: AI レビュアー（codex-review.yml）の指摘 80% を実装段階で潰す
> 同期元: [easy-flow リポジトリの `docs/operations/claude-md-template/common.md`](https://github.com/estack-inc/easy-flow/blob/main/docs/operations/claude-md-template/common.md)

### 背景

PR #203（openclaw-templates）で AI レビュー 20 ラウンドが発生した。指摘 80% は事前にガードレールがあれば回避可能だった既知パターン（機密情報ハードコード、`|| true` 握りつぶし、`set -euo pipefail` 罠、ファイル間整合性、スコープクリープ）。このベースラインは AI レビュアーが頻出する 6 カテゴリ（セキュリティ／シェル／Dockerfile／GitHub Actions／ファイル間整合性／テスト・E2E）を網羅する。各リポジトリの `codex-review.yml` の具体的なカテゴリ名・体系は異なる場合があるため、リポジトリ側 `CLAUDE.md` で必要に応じて補足する。

### 絶対禁止事項（全カテゴリ共通）

#### セキュリティ
- 機密情報（API キー・トークン・パスワード・DB 接続文字列）をソース・設定ファイル・ログ・PR コメントに直書きしない
- secrets の参照経路は以下のいずれか：`${{ secrets.* }}`（Actions）/ `fly secrets`（Fly.io）/ `process.env.*`（コード）
- `chmod 777` / `curl | bash`（信頼できないソースから）/ `eval` ユーザー入力 を禁止

#### シェルスクリプト品質
- 新規 `.sh` / `.bash` ファイルは `#!/usr/bin/env bash` + `set -euo pipefail` を採用
- **本リポジトリの実態**: TypeScript ESM Monorepo のため shell スクリプトはほぼ存在しない。`scripts/` 配下でビルド補助を書く場合は上記ルールに従う
- 変数は必ずクオート（`"$VAR"`）
- 一時ファイルは `mktemp` 使用、終了時クリーンアップ
- **`command || true` で失敗を握りつぶさない**（失敗を許容したいなら理由をコメント＋`if ! command; then ...; fi` で明示的にハンドリング）
- **`set -e` 下のコマンド戻り値取得の罠**: `command; RC=$?` は `command` 失敗時にスクリプトが落ちる。`set +e; command; RC=$?; set -e` か `command || RC=$?` を使う
- 外部入力（PR title、ENV、ファイル内容）はサニタイズしてからコマンドに渡す（コマンドインジェクション対策）

#### Dockerfile
- 新規アプリ用 Dockerfile は multi-stage build を採用、ランタイムは非 root ユーザーを原則とする
- ベースイメージタグはピン留め（`node:22-alpine` のように）。`latest` 禁止
- secrets を build args / レイヤーに焼かない
- COPY パスは実在するもののみ
- **本リポジトリの実態**: プラグイン Monorepo のため Dockerfile は**存在しない**。プラグイン利用側（OpenClaw ホスト）が配布イメージをビルドする

#### GitHub Actions
- secrets は `${{ secrets.* }}` 経由のみ
- permissions は最小権限（`contents: read` から始め、必要なものだけ追加）
- アクションバージョンはピン留め（`@v4` 等）。`@main` 禁止
- ワークフロー失敗時の Slack 通知は機密情報を含めない

#### ファイル間整合性
- 設定ファイル（`*.toml` / `*.json` / `*.yaml`）の値は他ファイルと完全一致
  - peer dependency 範囲: 各パッケージ `package.json` ↔ 社内 / クライアント OpenClaw 実バージョン ↔ `openclaw-templates/base/Dockerfile`
  - 環境変数名: コード ↔ README ↔ OpenClaw 設定 UI（`configSchema`）
  - MemoryChunk id 形式 / Pinecone namespace 形式: `pinecone-client/` ↔ `pinecone-context-engine/` ↔ `migrate-memory/` ↔ 既存 Pinecone データ
- README / 各パッケージ README に書かれたコマンド・パス・URL が実在することを変更時に確認
- ファイル単独編集では不十分なケースが多い → 下段「整合性マトリクス」を参照

#### テスト・E2E
- 新機能追加時は最小構成と全部入り構成の 2 ケースをテストに追加
- テスト関数で `export` した env は関数末で必ず `unset`（後続テストへのリーク防止）
- 本リポジトリのテストは **vitest**（`npm test` / `npm run test:integration`）。統合テストは `PINECONE_INTEGRATION=true` 必須
- Pinecone 統合テストは**本番 index / namespace を踏まない**テスト専用 namespace で実施

### PR スコープルール

- PR タイトルが表現する変更だけを含める。「ついで修正」「リファクタ同梱」は別 PR
- 変更行数 150 行超 / 変更ファイル 4 件超は分割を検討
- 構造変更（リネーム・並び替え・フォーマット）と動作変更を同一コミットに含めない
- 1 コミット = 1 論理的作業単位。すべてのテスト + リンター警告ゼロでのみコミット

### TDD サイクル

1. **Red**: 失敗するテストを書く（テスト名は動作を記述、失敗メッセージが分かりやすい）
2. **Green**: テストを通す最小限のコードを書く（最適化・美しさは無視）
3. **Refactor**: テストが通った状態でリファクタリング（一度に一つの変更、各ステップ後にテスト実行）

### PR 作成前セルフチェック

- [ ] PR タイトルが表現する 1 関心事のみを含む
- [ ] 機密情報の直書きがない（`PINECONE_API_KEY` / `OPENCLAW_*` 等を grep で確認）
- [ ] 変更したファイルと整合性マトリクス上の関連ファイルを同期した
- [ ] 新機能には最小・全部入り 2 ケースのテストを追加した
- [ ] テスト env を関数末で `unset` した
- [ ] README / 各パッケージ README のコマンド例を更新した（必要時）
- [ ] CI（lint + test）がローカルで通る

### AI レビュー対応ルール

- 🔴（重大）: 必ず修正してから再レビュー要求
- 🟡（要修正）: 原則修正。スキップする場合は PR 本文に `## AIレビュースキップ理由` セクションを追加し、各項目について理由を記述
- 同じ PR で 5 ラウンド以上発生したら、PR を分割するか作業を一旦止めてレビュー観点を整理する

### 参照（共通ベースライン）

表記ルール: `リポジトリ内` は本 repo 内の相対パス、`Easy Flow Wiki` は `estack-inc/easy-flow` repo 配下の資料で URL を直接記載する。

- AI レビュー設定 (リポジトリ内): `.github/workflows/codex-review.yml`
- 共通テンプレ管理 (Easy Flow Wiki): https://github.com/estack-inc/easy-flow/tree/main/docs/operations/claude-md-template
- リポジトリ別指示書 (Easy Flow Wiki): https://github.com/estack-inc/easy-flow/tree/main/docs/operations/claude-md-improvement-instructions

---

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
ビルド方式と `exports` の向き先はパッケージごとに異なる（ソース直接参照 / ビルド成果物参照 / 混在）。正本は各 `packages/*/package.json`。OpenClaw ホストへのプラグイン配布パッケージはビルド成果物（`./{subdir}/index.js`）を `exports` に設定する運用。

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
2. **Tool 群**（`api.registerTool`）— AI エージェントがワークフローを操作するためのツール群（正本は `packages/workflow-controller/index.ts` の `tools` 登録一覧）

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
- `peerDependencies: openclaw >=2026.3.22`（optional、正本は `packages/workflow-controller/package.json`）
- ESM モジュール（`"type": "module"`、import パスに `.js` 拡張子が必要）

### packages/model-router

ユーザープロンプトをルールベースで分類し、軽量タスクを Haiku 4.5 へ、複雑タスクを Sonnet 4.6 へ自動ルーティングする OpenClaw プラグイン（Phase 1 PoC）。

- `before_model_resolve` 単体フック構成（`registerHook` で登録）
- `classifyMessage()` — forceDefault キーワード → トークン数 → preferLight キーワードの優先順位で分類
- `ModelRouterConfig` — デフォルト設定（`DEFAULT_CONFIG`）と `pluginConfig` によるオーバーライドをサポート
- 戻り値: `{ modelOverride, providerOverride }`（Haiku）または void（Sonnet 維持）
- `model-router/` へのビルドあり（プラグインデプロイのため）
- `peerDependencies: openclaw >=2026.3.7`（optional）

### packages/migrate-memory

MEMORY.md ファイルを Pinecone ベクトル DB へ移行する CLI ツール。

- `Migrator` クラス — マークダウンをチャンク分割して Pinecone に upsert
- CLI: `npx easy-flow migrate` で実行
- 依存: `@easy-flow/pinecone-client`
- `dist/` へのビルドあり（CLI バイナリ提供のため）

### specs/

仕様書の管理ディレクトリ。spec-workflow MCP サーバーと連携。
現在 `pinecone-memory` の要件定義書・設計書が存在（Pinecone ベクトル DB によるメモリ最適化）。

## 共通の設計規約

- ESM モジュール（全パッケージ `"type": "module"`）
- `exports` の向き先（ソース直接参照 / ビルド成果物）はパッケージごとに異なる。正本は各 `packages/*/package.json`
- `peerDependencies: openclaw`（optional）— OpenClaw なしでもテスト可能
- テストは各パッケージの `devDependencies` で vitest を管理

## 編集禁止 / 慎重編集ファイル

- 各パッケージの `package.json` の `"type": "module"` / `exports`: 変更すると OpenClaw のローダーが解決失敗
- 各パッケージの `peerDependencies.openclaw`: ほとんどのパッケージは `>=2026.3.7`、`workflow-controller` のみ `>=2026.3.22`（正本は各 `packages/*/package.json`）。範囲変更は社内 / クライアント全インスタンスの分布確認とセット
- `pinecone-context-engine/` の Re-ranking ロジック: `final = vectorScore × 0.7 + sourceTypeWeight × 0.2 + freshnessScore × 0.1`。重み変更は検索品質に直結
- `openclaw-pinecone-plugin/` の `configSchema`: OpenClaw 設定 UI に直結。プロパティ定義は `openclaw.plugin.json` が正本。フィールド削除 / 型変更は既存設定壊し
- `workflow-controller/` の TaskFlowDefinition（6 種）/ Validators（4 種）: 進行中ワークフローの永続化 JSON と整合
- `file-serve/openclaw.plugin.json`: ネイティブプラグインメタ。OpenClaw が `/data/extensions/file-serve/` 経由で読み込む前提
- `migrate-memory/` の `agents` サブコマンド分割ロジック: AGENTS.md セクションのチャンク id 形式 `{agentId}:{sourceFile}:{chunkIndex}` を変えると既存 Pinecone データと不整合

## 絶対禁止事項（リポジトリ固有）

### モジュール構造
- **CommonJS への変換禁止**: `"type": "module"` を外す、`require()` を使う、`.cjs` ファイルを足す等は OpenClaw のローダー前提を壊す
- **`exports` の向き先変更禁止**: ソース直接参照（`./src/index.ts`）とビルド成果物参照（`./{subdir}/index.js` 等）がパッケージごとに使い分けられている（正本は各 `packages/*/package.json`）。片方へ統一する改変は OpenClaw 側のローダー解決やプラグイン配布前提を壊すため禁止
- **OpenClaw を peer から dependencies へ昇格禁止**: 必ず peer のまま。プラグインは OpenClaw が提供する SDK インスタンスを使う

### 永続化互換
- **`Set` / `Map` 型の永続化フィールドへの導入禁止**: `WorkflowState.completedStepIds` は `string[]`。`JSON.stringify(new Set([...]))` は `{}` になり保存内容が壊れる
- **MemoryChunk の id 形式変更禁止**: `{agentId}:{sourceFile}:{chunkIndex}` を維持。変更すると既存 Pinecone データの参照不能 / 重複投入が発生
- **Pinecone namespace 形式変更禁止**: `agent:${agentId}` 固定。変更は既存 namespace のデータが孤立

### Pinecone / シークレット
- **`PINECONE_API_KEY` のハードコード禁止**: 必ず ENV 経由
- **API キー無効時の暗黙フォールバック禁止**: 未設定時はプラグイン無効化（warn ログ）の現挙動を維持。サイレントに別ストレージへ切り替えるロジックを足さない
- **Pinecone 統合テストの本番インデックス利用禁止**: `PINECONE_INTEGRATION=true` フラグ実行時はテスト専用 namespace のみ

### OpenClaw 互換
- **OpenClaw 内部モジュール参照禁止**: `LegacyContextEngine` 等はプラグインから不可。NoopDelegate で代替する設計を維持
- **`openclaw.plugin.json` 必須フィールド削除禁止**: `id` / `configSchema` 等、現行 OpenClaw plugin manifest schema が要求するフィールド（正本は OpenClaw 本体の manifest schema）
- **`openclaw` peer 範囲の上方変更**: 現行範囲は各 `packages/*/package.json` が正本（上記「編集禁止 / 慎重編集ファイル」参照）。引き上げる場合は社内 / クライアント全インスタンスのバージョン分布を確認してから

## 整合性マトリクス

| 編集対象 | 同時に確認・更新が必要なファイル | 確認内容 |
|---|---|---|
| `pinecone-context-engine/` の Re-ranking 重み（vector/sourceType/freshness） | テスト fixture, `openclaw-pinecone-plugin/` の `configSchema`, RAG モード挙動 | スコア整合・既存挙動退行なし |
| `openclaw-pinecone-plugin/` の `configSchema`（定義は `openclaw.plugin.json`） | OpenClaw 設定 UI の表示, `openclaw-templates` 側のデフォルト値生成, README | 既存インスタンス設定との後方互換 |
| `workflow-controller/` の TaskFlowDefinition / Validators | 既存 WorkflowState 永続化 JSON, sessions_spawn の引数, systemPromptAddition フォーマット | 進行中ワークフローの破壊なし |
| `WorkflowState.completedStepIds` 型 | JSON 永続化ロジック, Set/Map 不使用ルール | 永続化互換 |
| `MemoryChunk.metadata.sourceType` の enum 値追加 | Re-ranking の `sourceTypeWeight`, `migrate-memory/` のチャンク生成, README | enum 完全性 |
| `MemoryChunk.id` 形式 / Pinecone namespace 形式 | 既存 Pinecone データ, `migrate-memory/` の id 生成, `pinecone-client/` の query | データ参照可能性 |
| `pinecone-client/` の LRU キャッシュサイズ（64 エントリ） | エンベッディング呼び出し回数, レイテンシ, Pinecone Inference 課金 | キャッシュ効率 |
| `file-serve/openclaw.plugin.json` | `openclaw-templates` の `entrypoint.sh`（`/data/extensions/file-serve/` 配置）, `/data/openclaw.json` の fallback 読み込み（#126） | ネイティブプラグイン登録整合 |
| `file-serve/` の publicUrl 解決順（pluginConfig > apiConfig > FLY_APP_NAME） | `openclaw-templates` の環境変数注入, LINE メッセージの URL 差し替え | 配信 URL 整合 |
| `migrate-memory/` の `agents` サブコマンド分割（`##` / `###`） | AGENTS-CORE.md フォーマット, RAG モードのコアコンテキスト, 既存 Pinecone データの id | 移行 / 検索整合 |
| `model-router/` のモデル切替ロジック | OpenClaw のモデル設定, クライアント別の許容モデル, 課金プラン | モデル誤選択防止 |
| `peerDependencies.openclaw` バージョン範囲 | 社内 / クライアント全インスタンスの実 OpenClaw バージョン分布, `openclaw-templates` の `base/Dockerfile` インストールバージョン | 互換性 |
| `ASSEMBLE_TIMEOUT_MS`（5000ms）変更 | RAG モード並列取得の挙動, 構造化ログの latency 集計, ユーザー体感レイテンシ | タイムアウト根拠維持 |

## 既知の罠（リポジトリ固有）

- **ESM の `__dirname` / `require` 不在**: `import.meta.url` ベースに書き換える。CommonJS 流儀を持ち込まない
- **`exports` の向き先がパッケージで異なる**: ソース直接参照のパッケージ（`./src/index.ts`）とビルド成果物参照のパッケージ（`./{subdir}/index.js`）が混在するため、ルールとして統一せず各 `packages/*/package.json` を正本として確認する
- **JSON 永続化で Set / Map が静かに壊れる**: `JSON.stringify(new Set([...]))` は `{}`。永続化フィールドは必ず配列・オブジェクトリテラル
- **Pinecone namespace の取り違え**: `agent:${agentId}` 形式。`agentId` を取り違えると別エージェントのメモリに混入
- **`PINECONE_API_KEY` 未設定時の挙動**: プラグイン無効化（warn ログのみ）。サイレントに別パスへフォールバックしない設計を維持
- **OpenClaw 内部モジュール非公開**: `LegacyContextEngine` はプラグインから参照不可。NoopDelegate で代替
- **互換バージョン差異**: 各パッケージの `openclaw` peer 範囲は揃っていない（正本は各 `packages/*/package.json`）。横断的に同一値へ揃えると上げ過ぎになる可能性があるため、実態を都度確認する
- **file-serve ネイティブプラグインの apiConfig 空問題**: `/data/extensions/file-serve/` 配置だと `api.pluginConfig` が空になる。`/data/openclaw.json` から fallback 読み込み（#126 fix）を消さない
- **RAG モードのタイムアウト**: AGENTS-CORE.md 読み込みと Pinecone query を並列実行（`ASSEMBLE_TIMEOUT_MS: 5000ms`）。延長は体感レイテンシに直結
- **Token 推定の近似**: CJK / 日本語は 1.5 tokens/char で近似。実 tokenizer ではないため予算ギリギリで切ると超過する
- **LRU キャッシュ 64 エントリ**: 短期間に多数の異なるテキストを embed する処理（一括移行等）はキャッシュヒット率が落ちる前提で設計
- **Re-ranking の重みは観測的根拠**: `vector × 0.7 + sourceType × 0.2 + freshness × 0.1` を変更する場合は AB 比較必須
- **RAG PoC 中インスタンス**: 社内 6 件で PoC 進行中。configSchema 変更は PoC 対象インスタンスに直撃
- **Pinecone 統合テスト**: `PINECONE_INTEGRATION=true` フラグ必須。本番 namespace を踏まないテスト用 namespace 設計を維持

## 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `PINECONE_API_KEY` | ✅（プラグイン有効時） | Pinecone Vector DB / Inference API |
| `OPENCLAW_*` | — | OpenClaw 提供の SDK 環境変数（peer 経由） |
| `PINECONE_INTEGRATION` | — | 統合テスト実行時のみ `true` |
| `FLY_APP_NAME` | —（file-serve のみ） | publicUrl 解決のフォールバック |

## 参照ドキュメント

### リポジトリ内
- `README.md`, 各パッケージ `packages/*/README.md`
- `RELATIONS.md` — パッケージ間依存関係
- `specs/` — 設計書・要件定義書

### Easy Flow Wiki（estack-inc/easy-flow）
- リポジトリ責務概要: https://github.com/estack-inc/easy-flow/blob/main/docs/repos/easy-flow-agent.md
- 共通ベースライン正本: https://github.com/estack-inc/easy-flow/blob/main/docs/operations/claude-md-template/common.md
