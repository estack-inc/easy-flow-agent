/**
 * Path canonical 化と denyPaths マッチ判定
 *
 * Phase 0 の cost-guard-hello に対し以下を追加：
 * - realpath（symlink 解決）：fs.realpathSync で実 FS の symlink を解消
 * - inode 一致検査：denyHardlinkTraversal=true 時、hardlink 候補のみ stat の (dev, ino) が denyPaths 配下のいずれかと一致するか確認
 * - 30+ 迂回パターン耐性：相対 path、`../`、cwd 起点、command 内 redirection、option value 隣接、bare filename、
 *   symlink、hardlink、/proc/self/fd 経由、URL-encoded、二重 slash、末尾 slash 有無
 *
 * 30+ 迂回パターンの内訳：
 *  1. 絶対 path 直書き
 *  2. `../` 経由
 *  3. `./` 経由
 *  4. 二重 slash `//`
 *  5. 末尾 slash 有無
 *  6. URL-encoded（`%2F`, `%2E`）
 *  7. cwd 起点の相対 path
 *  8. workdir 起点の相対 path
 *  9. dir 起点の相対 path
 * 10. bare filename + cwd
 * 11. command 内 redirection `<`
 * 12. command 内 `>`
 * 13. command 内 option value `--file=`
 * 14. command 内 pipe `|`
 * 15. command 内空白区切り
 * 16. args 配列の各要素
 * 17. ネスト object
 * 18. ネスト array
 * 19. base64 で偽装した path → 元 string で検出（補助）
 * 20. symlink 経由（realpath で解決）
 * 21. hardlink 経由（inode 一致で検出）
 * 22. /proc/self/fd 経由（path token で捕捉）
 * 23. /proc/<pid>/root/... 経由
 * 24. 大文字小文字混在（macOS では区別、Linux では区別 → 文字列比較）
 * 25. UTF-8 異常文字混入（NFC 正規化）
 * 26. 改行混入（CR / LF / CRLF）
 * 27. tab 混入
 * 28. zero-width space 混入
 * 29. 末尾空白
 * 30. 先頭空白
 * 31. 連続 `../` (`/../../../`)
 * 32. 自己参照 `./.`
 *
 * 実 FS 不在時（CI / unit test）は realpath / stat エラーを無視し、文字列ベースの canonical 化のみで判定。
 */
export interface PathCheckOptions {
    denyPaths: string[];
    denyHardlinkTraversal: boolean;
    resolveSymlinks: boolean;
}
export interface PathMatchResult {
    matched: string;
    field: string;
    reason: "deny_path_match" | "deny_path_match_symlink" | "deny_path_match_inode";
}
/**
 * tool params を再帰走査し、denyPaths にマッチする path 候補を探す。
 *
 * @returns マッチがあれば PathMatchResult、なければ null
 */
export declare function findDenyPathMatch(params: unknown, options: PathCheckOptions): PathMatchResult | null;
/**
 * 文字列を path-like 解釈して canonical 化候補集合を返す。
 *
 * 候補（cost-guard-hello から拡張）：
 * - 元の文字列（生）
 * - URL-decode（`%2F`/`%2E` 等の de-obfuscate）
 * - 不可視文字（zero-width space, BOM, NBSP, タブ）を除去した変種
 * - 空白除去
 * - path.resolve("/", s) … 絶対起点
 * - path.resolve(s) … cwd 起点
 * - path.resolve(baseDir, s) … baseDir 起点（cwd / workdir / dir）
 * - command-like field では bare filename token も baseDir 起点で resolve
 * - command 内の path token / 埋め込み絶対 path も再帰展開
 */
export declare function expandPathCandidates(s: string, baseDirs: string[], includeBareTokens: boolean): string[];
/**
 * 候補 path が denyPath 配下にあるか判定する。
 * - 候補を normalize した結果が deny と同一、または deny + path.sep プレフィックスを持てば true
 * - deny が `/` の場合は任意の絶対 path を deny 扱い
 */
export declare function isWithinDenyPath(candidate: string, normalizedDeny: string): boolean;
export declare function normalizePathForMatch(value: string): string;
//# sourceMappingURL=path-checker.d.ts.map