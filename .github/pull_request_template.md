## 概要

{変更の目的・背景を 1-2 文で}

## 変更の種類

- [ ] バグ修正 (bug fix)
- [ ] 新機能 (new feature)
- [ ] 機能改善 (enhancement)
- [ ] リファクタリング (refactoring)
- [ ] テスト追加・修正 (test)
- [ ] ドキュメント (docs)
- [ ] CI/CD・設定 (chore)

## 関連 Issue

Closes #XX

## 要件（AI レビューで充足確認されます）

- [ ] {この PR で達成すべき要件 1}
- [ ] {この PR で達成すべき要件 2}

## 変更内容

- {変更点 1}
- {変更点 2}

## 影響パッケージ

- [ ] pinecone-client
- [ ] pinecone-context-engine
- [ ] openclaw-pinecone-plugin
- [ ] workflow-controller
- [ ] migrate-memory
- [ ] なし（ルート設定・CI のみ）

## Breaking Changes

- なし
<!-- または具体的に記載:
- `WorkflowState` の `steps` フィールドの型を `Step[]` → `StepMap` に変更
-->

## テスト

- [ ] 既存テスト全パス (`npm test`)
- [ ] 新規テスト追加（必要な場合）
- [ ] 手動確認（該当する場合）

## クロスリポジトリへの影響

- [ ] なし
- [ ] openclaw-templates への影響あり: {内容}
- [ ] easy-flow-infra への影響あり: {内容}
- [ ] openclaw-clients への影響あり: {内容}

## チェックリスト

- [ ] コードの自己レビュー完了
- [ ] テスト通過
- [ ] 型エラーなし
- [ ] CLAUDE.md / specs/ の更新（必要な場合）

<!-- n8n Slack通知連携: 以下は自動通知用メタデータ。slack_channel はデフォルト通知先。slack_thread_ts と slack_agent_mention は PR 作成時にエージェントが設定する -->
<!-- slack_channel: C0ALHTE50Q5 -->
<!-- slack_thread_ts: -->
<!-- slack_agent_mention: -->
