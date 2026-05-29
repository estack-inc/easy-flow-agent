# easy-flow-agent セキュリティポリシー

このファイルは `security-guidance` プラグインの層 2（diff レビュー）プロンプトに自動添付される。easy-flow-agent で守るべきセキュリティ要件を、レビュー LLM が「拒否すべき実装パターン」として認識できる形で記述する。シークレット値は絶対に記載しない。

## 禁止事項

- main / master ブランチへの直接 push は禁止。必ず feature/ / fix/ / docs/ プレフィックスのブランチを切って PR 経由で反映する
- Fly.io インスタンスの削除は禁止。インスタンス削除を伴う変更は人間の承認なしには行わない
- API キー・パスワード・秘密鍵・データベース接続文字列・OAuth クライアントシークレットをコード・ログ出力・コメント・コミット対象の設定ファイルに直書きしない。環境変数または secret manager 経由で扱う
- AWS / GCP / Anthropic / OpenAI / Pinecone / Upstash のいずれの API キーらしき文字列の直書きも拒否する
- 認証トークン・セッショントークン・ユーザー個人情報を、構造化ログ・汎用ログ・デバッグ出力を含むいかなるログ・出力先にも生の値で出力しない。これらを含むリクエスト・ヘッダー・Cookie・セッション・ユーザーオブジェクトの丸ごと出力も同様に拒否する。記録が必要な場合は、漏えいしても認証・本人特定・値の復元・横断追跡に使えない形にマスキングまたはハッシュ化した値のみを残す（先頭・末尾だけを残す伏字や、ソルトなしの単純ハッシュは不可）

## 必須プロトコル

- Fly.io へのデプロイは、各リポジトリで確立されたデプロイ手順に従う。デプロイ経路を無断で変更・迂回する実装は拒否する。`safe-deploy.sh` を持つリポジトリ（クライアントインスタンス等）では同スクリプトを経由する。`safe-deploy.sh` を持たず、`fly deploy` の直接実行や `flyctl secrets set` 等で運用するリポジトリ（easy-flow-infra・easy-flow-real-estate-portal 等）では、その確立手順に従う
- 外部から受信する webhook は HMAC 署名を必ず検証する。署名検証を省略する実装、または検証前に副作用を伴う処理を実行する実装は拒否する
- 認証が必要な API endpoint では、リクエストパラメータの ID と認証ユーザーの所有権限の紐付けを必ず検証する。クエリパラメータの ID を検証せず DB クエリに渡す実装（IDOR 脆弱性）は拒否する
- ユーザー入力を DOM に挿入する処理で、エスケープなしの生の HTML 文字列挿入は拒否する。テンプレートエンジンの自動エスケープ、または明示的な sanitize 経由を要求する
- DB 検索クエリは ORM またはプレースホルダ付きの prepared statement を経由する。文字列連結で SQL を組み立てる実装は拒否する
- 外部 URL への HTTP リクエストで、ユーザー入力に由来する URL をそのまま送出する実装は SSRF リスクとして拒否する。送信先ホストの allowlist 検証を要求する
- 外部コマンド実行で、ユーザー入力を shell 文字列に連結する実装は拒否する。引数配列形式で渡す呼び出しを要求する
- ファイルパスを扱う処理で、ユーザー入力を直接 path 結合する実装は path traversal リスクとして拒否する。正規化と prefix 検証を要求する

## easy-flow-agent 固有の制約

- Pinecone API キー（`PINECONE_API_KEY`）は環境変数経由でのみ扱う。コード・テスト fixture・ログに直書きする実装は拒否する。キー未設定時はプラグイン無効化（warn ログのみ）が正常動作であり、キーをハードコードして回避する実装は拒否する
- Pinecone 統合テスト（`PINECONE_INTEGRATION=true`）で本番 Pinecone index / 本番 API キーを使用する実装は拒否する。通常テストが API キー不要で動く設計を壊す変更も拒否する
- file-serve のファイル配信は UUID + TTL 経由のみとする。ユーザー入力由来のファイル名・パスを直接ファイルシステムパスへ結合する実装は path traversal リスクとして拒否する
- Pinecone namespace は `agent:${agentId}` 形式で固定とする。agentId をまたいで他エージェントの namespace を参照・書き込みする実装（エージェント間メモリ越境）は拒否する
- `openclaw/openclaw`（外部 org）の Plugin SDK / ContextEngine インターフェースへの破壊的変更を本リポジトリ側から前提にする実装は拒否する。peerDependency バージョン制約（workflow-controller は openclaw >=2026.3.22 等）を壊す変更も拒否する

## 参照

- Easy Flow メタリポジトリ横断ポリシー: <https://github.com/estack-inc/easy-flow/blob/main/.claude/claude-security-guidance.md>
- security-guidance プラグイン運用ルール: <https://github.com/estack-inc/easy-flow/blob/main/.claude/rules/security-guidance.md>
- Fleet 運用ルール: <https://github.com/estack-inc/easy-flow/blob/main/.claude/rules/multi-agent.md>
