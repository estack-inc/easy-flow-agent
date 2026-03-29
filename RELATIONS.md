# RELATIONS.md — easy-flow-agent

## 概要

OpenClaw 向けプラグイン monorepo。Pinecone ベクトル DB によるメモリ管理（pinecone-client / pinecone-context-engine / pinecone-memory）とワークフロー実行制御（workflow-controller）を提供。

## 依存先

- **openclaw** (npm: `openclaw >=2026.3.7`) — 全プラグインパッケージの peerDependency。`registerContextEngine` / `registerTool` API を使用
- **openclaw-templates** — Dockerfile で本リポをクローンし、entrypoint.sh で起動時に `git pull` で最新化。プラグイン設定は `openclaw.json` の `plugins` セクションで参照
- **easy-flow-infra** — ビルドジョブ（worker.js）が openclaw-templates 経由で本リポのプラグインを含むインスタンスを構築

## 依存元

- **openclaw-templates** — Dockerfile の `git clone` で本リポを取得。`entrypoint.sh` で起動時に自動 pull
- **openclaw-clients** — 各クライアントの `openclaw.json` でプラグインパスを指定（例: `mell/openclaw.json`）
- **easy-flow-infra** — worker.js が build-instance.sh 経由で本リポを含むインスタンスを構築

## 双方向依存

- **openclaw-templates**
  - **本リポ → templates**: peerDep の openclaw バージョン要件が templates の Dockerfile に制約を与える
  - **templates → 本リポ**: Dockerfile で clone、entrypoint.sh で git pull、openclaw.json でプラグイン参照

## 影響範囲

- **プラグイン API 変更**（register 関数のシグネチャ等）→ openclaw-templates の `openclaw.json` プラグイン設定を確認
- **Workflow Controller のツール名・スキーマ変更** → openclaw-clients 内の各クライアントスキル定義を確認
- **Pinecone プラグインの設定キー変更** → openclaw-templates の環境変数・pluginConfig を確認
- **peerDep の openclaw バージョン引き上げ** → openclaw-templates の Dockerfile でインストールされるバージョンとの互換性を確認
- **パッケージ追加・削除** → openclaw-templates の Dockerfile の clone 対象パスを確認
