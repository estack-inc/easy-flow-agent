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

ワークフロー状態管理とステップ実行制御を行う OpenClaw プラグイン。

- ContextEngine によるワークフロー状態のプロンプト注入
- 5 つのワークフロー操作ツール（create / advance / block / status / update_context）
- ファイルベースの永続化ストア

### migrate-memory

MEMORY.md ファイルを Pinecone ベクトル DB へ移行する CLI ツール。

## Development

```bash
npm install
npm test
```

## License

Private / eSTACK Inc.
