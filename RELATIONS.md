# RELATIONS.md — easy-flow-agent

## 概要
AI エージェントコア。Workflow Controller、Token Optimizer、PII Hardening 等の OpenClaw 改善パッケージ。

## 依存先
- openclaw-templates（テンプレート設定・Dockerfile を参照）
- easy-flow-infra（デプロイ先のインフラ定義）

## 依存元
- openclaw-templates（agent パッケージとして参照）
- easy-flow-infra（ビルド時に利用）
- mell-workspace（メルのスキル・設定で参照）

## 影響範囲
- パッケージ API 変更 → openclaw-templates の Dockerfile・設定を確認
- Workflow Controller 変更 → mell-workspace のスキル定義を確認
- PII ルール変更 → openclaw-clients の各クライアント設定を確認
