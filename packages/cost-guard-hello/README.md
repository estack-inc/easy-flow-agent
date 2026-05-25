# cost-guard-hello

OpenClaw 2026.5.12 向け **Phase 0 実証用** observe-only plugin。

`before_tool_call` / `tool_result_persist` / `before_agent_run` の発火を `api.logger.info` で記録するだけで、block / rewrite / outcome 変更は一切しない。Phase 0 の以下の検証で土台として使う：

| 実証 | 観測対象 |
|---|---|
| 実証 A: lossless-claw 実装方式の特定 | bundled plugin との hook 評価順序を log で実測 |
| 実証 C: before_agent_run block → Slack 配信 | （後続 PR で block 戻り値に切替）|

詳細：[easy-flow リポジトリの transcript-cost-prevention-phase0.md](https://github.com/estack-inc/easy-flow/blob/main/docs/operations/transcript-cost-prevention-phase0.md)

## install（dev-and-test-agent 限定）

```bash
# ローカル開発：このディレクトリで build
npm install
npm run build

# dev-and-test-agent に link install（PR マージ後に npm 公開も可）
openclaw plugins install --link ./packages/cost-guard-hello

# 確認
openclaw plugins list
openclaw plugins inspect cost-guard-hello --runtime --json
```

## 設定（openclaw.json）

### observe モード（既定）

```json
{
  "plugins": {
    "allow": ["cost-guard-hello"],
    "entries": {
      "cost-guard-hello": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "logging": true,
          "verbose": false
        }
      }
    }
  }
}
```

### block モード（Phase 0 実証 B-3 以降）

```json
{
  "plugins": {
    "entries": {
      "cost-guard-hello": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "logging": true,
          "verbose": false,
          "blockMode": "block",
          "blockPaths": ["/data/workspace/zoom_transcribe/"]
        }
      }
    }
  }
}
```

`before_agent_run` を外部 plugin から使うため `allowConversationAccess: true` が必須。**正しいパスは `plugins.entries.<id>.hooks.allowConversationAccess`**（`hooks.` を間に挟む）。`plugins.entries.<id>.allowConversationAccess` 直下に書くと `Unrecognized key` で reload に失敗する。2026-05-25 の dev-and-test-agent 実機検証で確定（公式ドキュメント [/plugins/hooks](https://docs.openclaw.ai/plugins/hooks) には明記されていない）。

## 設定項目

| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `logging` | boolean | `true` | hook 発火時に observation log を出力する |
| `verbose` | boolean | `false` | tool params の概略を最大 200 byte まで log に含める（transcript 本体・プロンプト全文は吐かない）|
| `blockMode` | `"observe"` / `"block"` | `"observe"` | observe=log のみ / block=`blockPaths` にマッチした tool 呼び出しを block する |
| `blockPaths` | string[] | `[]` | block 対象 path のプレフィックス。tool params 内の文字列フィールド（`path` / `command` / nested array 等）を再帰走査し、canonical 化（`path.resolve` で `../` を解決）した結果と元文字列の両方でマッチを判定 |

### block ロジックの限界（Phase 1 で対処）

- symlink 解決（`realpath`）は実施しない：本 plugin は agent 動作前 hook なので実 FS には触らない
- inode / device 比較もしない
- `/proc/self/fd` 経由は元文字列に proc path が含まれている場合のみ捕捉
- shell injection（`$(...)`, `` `...` `` 経由）は元文字列に path が出ない場合 block 不可
- これらは Phase 0 実証 B-4 の漏れパターン候補として Phase 1 設計（本格 cost-guard plugin）で対処予定

## 観測 log の形式

```
[cost-guard-hello] registered (logging=true, verbose=false)
[cost-guard-hello] before_tool_call: tool=read
[cost-guard-hello] tool_result_persist: tool=read call_id=tcid_xxx synthetic=false
[cost-guard-hello] before_agent_run: prompt_len=1234 messages=8 account=Uxxx channel=Cxxx owner=true
```

## 注意事項

- **observe-only**：本 plugin は出力を観察するだけで cost 削減効果はない
- **本番禁止**：Phase 0 検証用。dev-and-test-agent 以外には install しない
- **Phase 1 で置換**：Phase 0 完了後、本格的な `cost-guard` plugin（block / rewrite 機能あり）に置き換える前提

## 削除（Phase 0 完了後）

```bash
openclaw plugins uninstall cost-guard-hello
```

そして本ディレクトリも削除する（PR ベースで）。
