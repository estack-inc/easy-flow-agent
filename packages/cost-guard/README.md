# cost-guard

OpenClaw 2026.5.12 以降向け **Phase 1 本格版 cost-guard plugin**。`hongmong-ochi-agent` の transcript コスト爆発（$1990/月）への構造対策として、`denyPaths` 配下への汎用 file access を **default deny + tool allowlist** で遮断する。

## 概要

3 hook で agent コストを多層防御する：

| hook | 役割 |
|---|---|
| `before_tool_call` | `denyPaths` 配下への汎用 tool 呼び出しを block。`allowlistedToolsForDenyPaths` のみ通過。`commandDenylist` の AST 検査で shell injection 経由の迂回を捕捉 |
| `tool_result_persist` | tool result の合計 byte 数が `rewriteThresholdBytes` を超えた場合に sentinel 文字列で置換。`tool_call_id` を保持して LLM 入力構築の整合性を保つ |
| `before_agent_run` | 段 1: per-turn prompt input gate → 段 2: session 単位 token budget breaker → 段 3: `cleanupOnSessionStart=true` 時に過去 messages の `denyPaths` 参照を sentinel 置換 |

詳細設計：[Phase 1 設計 v6（estack-inc/easy-flow#398）](https://github.com/estack-inc/easy-flow/pull/398)
契約：本案件の `contracts.md`（同 case 配下）

## install（OpenClaw extension として）

```bash
# ローカル開発：build
cd packages/cost-guard
npm install
npm run build

# OpenClaw に link install
openclaw plugins install --link ./packages/cost-guard

# 確認
openclaw plugins list
openclaw plugins inspect cost-guard --runtime --json
```

## 設定（openclaw.json）

### 本番既定（Phase 1）

```json
{
  "plugins": {
    "allow": ["cost-guard"],
    "entries": {
      "cost-guard": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "blockMode": "block",
          "denyPaths": ["/data/workspace/zoom_transcribe/"],
          "allowlistedToolsForDenyPaths": [
            "transcript-analyzer.list_transcripts",
            "transcript-analyzer.search_transcripts",
            "transcript-analyzer.analyze_transcript"
          ],
          "rewriteThresholdBytes": 50000,
          "sessionTokenBudget": 500000,
          "perTurnPromptInputThreshold": 50000,
          "denyHardlinkTraversal": true,
          "cleanupOnSessionStart": true
        }
      }
    }
  }
}
```

### dev 検証用（observe モード）

`blockMode: "observe"` は **dev / staging instance 限定**。本 plugin が hook を log するだけで戻り値で block / rewrite しない。metric は本番と同じく発行されるため、影響予測の dry-run として使う。

```json
{
  "plugins": {
    "entries": {
      "cost-guard": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "blockMode": "observe",
          "denyPaths": ["/data/workspace/zoom_transcribe/"]
        }
      }
    }
  }
}
```

`before_agent_run` を外部 plugin から使うため `hooks.allowConversationAccess: true` が必須。**正しい場所は `plugins.entries.<id>.hooks.allowConversationAccess`**（`hooks.` を間に挟む）。

## 設定項目（contracts.md §9.1）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `logging` | boolean | `true` | hook 発火時に `api.logger` で観測 log を出力 |
| `verbose` | boolean | `false` | tool params の概略を最大 200 byte まで log に含める |
| `blockMode` | `"observe"` / `"block"` | `"block"` | Phase 1 本番既定は `block`。`observe` は dev 検証専用 |
| `denyPaths` | string[] | `["/data/workspace/zoom_transcribe/"]` | default deny する path のプレフィックス |
| `allowlistedToolsForDenyPaths` | string[] | `transcript-analyzer.*` の 3 件 | `denyPaths` 配下にアクセス可能な tool id allowlist |
| `rewriteThresholdBytes` | number | `50000` | `tool_result_persist` で sentinel 置換する閾値 |
| `sessionTokenBudget` | number | `500000` | session 単位の cumulative token 上限 |
| `perTurnPromptInputThreshold` | number | `50000` | 次ターン prompt input 上限（推論直前 gate） |
| `commandDenylist` | string[] | `["eval", "bash -c $", "sh -c $", "<(", "$(", "`"]` | command の AST 検査での deny パターン |
| `denyHardlinkTraversal` | boolean | `true` | hardlink 経由で `denyPaths` に到達する path を inode 一致で検出。通常 path では directory 走査せず、hardlink 候補のみ短時間 cache 付きで確認 |
| `cleanupOnSessionStart` | boolean | `true` | 過去 messages の `denyPaths` 参照を sentinel 置換 |
| `suspendAgent` | boolean | `false` | rollback Mode A：agent 一時停止 |

## block 応答（contracts.md §7.1）

`before_tool_call` が block を返す際の戻り値は contracts.md §2.1 の `BeforeToolCallResult` 準拠：

```ts
{
  block: true,
  blockReason: "deny_path_match" | "deny_path_match_inode" | "deny_path_match_symlink" | "command_denylist_match" | "tool_not_in_allowlist",
  message: "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。"
}
```

`before_agent_run` の block も同様に contracts.md §7.2 準拠：

```ts
// 段 1
{ outcome: "block", reason: "per_turn_input_too_large", message: "次ターンの入力サイズが大きすぎるため処理できません..." }

// 段 2
{ outcome: "block", reason: "session_token_budget_exceeded", message: "このセッションのトークン上限を超えたため..." }
```

## metric（contracts.md §10.1）

OpenClaw runtime の `api.metrics.incrementCounter` 経由で以下を発行する。`api.metrics` 未提供の OpenClaw バージョンでも plugin は動作する：

| metric 名 | 型 | 発火タイミング |
|---|---|---|
| `cost_guard.tool_call_blocked` | counter | `before_tool_call` で block / observe 通知 |
| `cost_guard.tool_result_rewritten` | counter | `tool_result_persist` で sentinel 置換 |
| `cost_guard.per_turn_input_blocked` | counter | `before_agent_run` 段 1 で block |
| `cost_guard.session_budget_exceeded` | counter | `before_agent_run` 段 2 で block |
| `cost_guard.transcript_pollution_detected` | counter | 過去 messages の sentinel 置換 |

## 30+ 迂回パターン耐性

`packages/cost-guard/src/path-checker.ts` で以下の迂回パターンを構造的に塞ぐ：

1. 絶対 path 直書き
2. `../` 経由
3. `./` 経由
4. 二重 slash `//`
5. 末尾 slash 有無
6. URL-encoded (`%2F`, `%2E`)
7. cwd 起点の相対 path
8. workdir 起点の相対 path
9. dir 起点の相対 path
10. bare filename + cwd（command-like field）
11. command 内 redirection `<`
12. command 内 redirection `>`
13. command 内 option value `--file=`
14. command 内 pipe `|`
15. command 内空白区切り
16. args 配列の各要素
17. ネスト object
18. ネスト array
19. base64 偽装 → 元 string で検出（補助）
20. symlink 経由（`realpath` で解決）
21. hardlink 経由（inode 一致で検出）
22. `/proc/self/fd`, `/proc/<pid>/root/...`
23. 自己参照 `./.`
24. 連続 `../../..`
25. 不可視文字（ZWSP, NBSP, BOM）
26. 改行混入（CR / LF / CRLF）
27. tab 混入
28. 末尾空白
29. 先頭空白
30. args 内 option value
31. args 内 redirection
32. NFKC 正規化（全角 → 半角）

詳細は `src/path-checker.test.ts` の各テストケース参照。

## アーキテクチャ

```
packages/cost-guard/
├── openclaw.plugin.json    # OpenClaw plugin metadata（id / configSchema）
├── package.json            # npm package + openclaw.extensions
├── tsconfig.json
├── README.md               # 本ファイル
└── src/
    ├── index.ts            # register(api) entry point + 3 hook implementation
    ├── index.test.ts       # hook unit test（block / sentinel / breaker / metric）
    ├── path-checker.ts     # 30+ 迂回パターン path canonical 化 + realpath + inode
    ├── path-checker.test.ts
    ├── command-checker.ts  # commandDenylist AST 検査
    ├── command-checker.test.ts
    ├── token-estimator.ts  # token 数の軽量近似（utf8_bytes / 4）
    ├── token-estimator.test.ts
    ├── sentinel.ts         # sentinel 文字列生成 + byte 計算
    └── sentinel.test.ts
```

## test / build / lint

```bash
# 単体テスト（vitest, coverage ≥ 90%）
npm test

# 監視モード
npm run test:watch

# TypeScript 型チェック
npm run typecheck

# Biome lint
npm run lint

# build（cost-guard/ 配下に .js / .d.ts 出力）
npm run build
```

## 注意事項（運用）

- **Phase 1 本番既定は `blockMode: "block"`**。`observe` は dev / staging instance のみで使う
- **Sonnet 全文 fallback は禁止**：本 plugin の block により transcript 全文 read が遮断された場合、agent は `transcript-analyzer.*` 経由で要約取得すること（block 応答の `message` に明示）
- **rollback Mode A**：`suspendAgent: true` 設定で agent run 自体を停止できる。緊急時の運用用
- **leaf_node: false**：本 plugin は denyPaths + allowlist で全 tool 呼び出しを判定する critical path のため、変更時は Owner 目視確認推奨

## 関連 Issue / PR

- 案件：[transcript-cost-prevention-phase1-impl](https://github.com/estack-inc/easy-flow/tree/main/docs/operations/multi-agent-cases/transcript-cost-prevention-phase1-impl)
- 関連 Issue：[estack-inc/easy-flow#360](https://github.com/estack-inc/easy-flow/issues/360) / [estack-inc/easy-flow#376](https://github.com/estack-inc/easy-flow/issues/376)
- Phase 0 実証用 plugin：`packages/cost-guard-hello/`（Phase 1 完了後に削除 PR）
