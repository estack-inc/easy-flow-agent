# easy-flow-agent

OpenClaw improvements for the Easy Flow AI Agent Service.

## Packages

### pinecone-client

Pinecone ベクトル DB の低レベルクライアントラッパー。upsert / query / delete、テキスト分割、Embedding 生成、インデックス管理を提供。

### pinecone-context-engine

Pinecone を使った OpenClaw ContextEngine 実装。セマンティック検索による長期記憶の取得・蓄積を行い、`assemble()` で関連記憶をプロンプトに注入する。

### openclaw-pinecone-plugin

PineconeContextEngine を OpenClaw の context-engine プラグインスロットに登録する薄いラッパー。`api.registerContextEngine("pinecone-memory", factory)` で統合。

### workflow-controller

ワークフロー状態管理・ステップ実行制御・バリデーションを行う OpenClaw プラグイン。

#### コア機能

- ContextEngine によるワークフロー状態のプロンプト注入
- 7 つのワークフロー操作ツール（`workflow_create` / `workflow_advance` / `workflow_branch` / `workflow_block` / `workflow_status` / `workflow_update_context` / `workflow_resume`）
- Issue 番号紐づけによる状態永続化（`workflow_resume` で中断後も復帰可能）
- ファイルベースの永続化ストア

#### taskflows — タスクフロー定義（6種）

アイコン別の標準フローを WC ステップとして定義。`getTaskFlow(flowId)` でロードして使用する。

| flowId | トリガー | 概要 |
|--------|---------|------|
| `taskflow_task` | 📋 | 要件深掘り → 設計 → タスク分割 → 実行 → レビュー → 検収 |
| `taskflow_command` | 📢 | 最優先・即実行。task-validator のみ適用 |
| `taskflow_consult` | 💬 | 検討・複数案提示。タスクに発展する場合は taskflow_task を起動 |
| `taskflow_bug` | 🐛 | トリアージ分岐・close_no_fix あり |
| `taskflow_report` | 📊 | シンプル3ステップ |
| `taskflow_idea` | 💡 | 評価・却下分岐あり |

#### validators — バリデーションサブエージェント（4種）

各フェーズ完了時に `sessions_spawn` で起動し、PASS / NEEDS_IMPROVEMENT / MAJOR_ISSUES を返す。

| バリデーター | 担当フェーズ |
|------------|------------|
| `requirements-validator` | 要件深掘り完了後 |
| `design-validator` | 設計完了後 |
| `task-validator` | タスク分割完了後 |
| `output-reviewer` | 実行完了後 |

共通型定義: `validators/types.ts`（`ValidationResult` / `ValidationRating`）

### migrate-memory

MEMORY.md ファイルを Pinecone ベクトル DB へ移行する CLI ツール。

## Development

```bash
npm install
npm test
```

## License

Private / eSTACK Inc.
