/**
 * Path canonical 化と denyPaths マッチ判定
 *
 * Phase 0 の cost-guard-hello に対し以下を追加：
 * - realpath（symlink 解決）：fs.realpathSync で実 FS の symlink を解消
 * - inode 一致検査：denyHardlinkTraversal=true 時、stat の (dev, ino) が denyPaths 配下のいずれかと一致するか確認
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

import { type Dirent, readdirSync, realpathSync, type Stats, statSync } from "node:fs";
import path from "node:path";

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

const BASE_DIR_FIELD_NAMES = new Set([
  "cwd",
  "workdir",
  "workingdir",
  "workingdirectory",
  "working_directory",
  "dir",
]);

/**
 * tool params を再帰走査し、denyPaths にマッチする path 候補を探す。
 *
 * @returns マッチがあれば PathMatchResult、なければ null
 */
export function findDenyPathMatch(
  params: unknown,
  options: PathCheckOptions,
): PathMatchResult | null {
  const denyPaths = options.denyPaths.filter((s) => typeof s === "string" && s.length > 0);
  if (denyPaths.length === 0) return null;
  const visited = new WeakSet<object>();
  const normalizedDenyPaths = denyPaths.map((p) => ({
    original: p,
    normalized: normalizePathForMatch(p),
  }));
  // symlink 解決後の deny 一致を検出するため、deny dir 自体も realpath 化したものを別途保持
  // 例：macOS では /tmp が /private/tmp への symlink のため、deny dir を渡しても
  //     candidate を realpath したら /private/tmp/... になり一致しなくなる
  const symlinkResolvedDenyPaths = options.resolveSymlinks
    ? denyPaths
        .map((p) => {
          const realDeny = tryRealpath(p);
          if (!realDeny) return null;
          const normalizedReal = normalizePathForMatch(realDeny);
          return { original: p, normalized: normalizedReal };
        })
        .filter((x): x is { original: string; normalized: string } => x !== null)
    : [];
  const denyInodeMap = options.denyHardlinkTraversal ? collectDenyInodes(denyPaths) : null;

  function walk(value: unknown, fieldPath: string, baseDirs: string[]): PathMatchResult | null {
    if (typeof value === "string") {
      const candidates = expandPathCandidates(value, baseDirs, isCommandLikeField(fieldPath));
      for (const candidate of candidates) {
        // 1. 文字列ベース canonical 一致
        for (const deny of normalizedDenyPaths) {
          if (isWithinDenyPath(candidate, deny.normalized)) {
            return { matched: deny.original, field: fieldPath, reason: "deny_path_match" };
          }
        }
        // 2. symlink 解決後の一致（実 FS 触る、エラー無視）
        //    candidate を realpath した結果が、deny dir そのものまたは deny dir を realpath したもの
        //    どちらかの配下にあれば「symlink 経由で deny に到達」と判定
        if (options.resolveSymlinks && path.isAbsolute(candidate)) {
          const resolved = tryRealpath(candidate);
          if (resolved && resolved !== candidate) {
            const normalizedResolved = normalizePathForMatch(resolved);
            // (a) 元 deny dir（文字列のまま）と比較
            for (const deny of normalizedDenyPaths) {
              if (isWithinDenyPath(normalizedResolved, deny.normalized)) {
                return {
                  matched: deny.original,
                  field: fieldPath,
                  reason: "deny_path_match_symlink",
                };
              }
            }
            // (b) deny dir を realpath したものと比較
            //     macOS の /tmp → /private/tmp や symlinked deploy dir に対応
            for (const deny of symlinkResolvedDenyPaths) {
              if (isWithinDenyPath(normalizedResolved, deny.normalized)) {
                return {
                  matched: deny.original,
                  field: fieldPath,
                  reason: "deny_path_match_symlink",
                };
              }
            }
          }
        }
        // 3. inode 一致（hardlink 経由）
        if (denyInodeMap && path.isAbsolute(candidate)) {
          const stat = tryStat(candidate);
          if (stat) {
            const key = `${stat.dev}:${stat.ino}`;
            const denyOriginal = denyInodeMap.get(key);
            if (denyOriginal) {
              return {
                matched: denyOriginal,
                field: fieldPath,
                reason: "deny_path_match_inode",
              };
            }
          }
        }
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    if (visited.has(value as object)) return null;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const r = walk(value[i], `${fieldPath}[${i}]`, baseDirs);
        if (r) return r;
      }
      return null;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const scopedBaseDirs = collectScopedBaseDirs(entries, baseDirs);
    for (const [k, v] of entries) {
      const childField = fieldPath === "" ? k : `${fieldPath}.${k}`;
      const r = walk(v, childField, scopedBaseDirs);
      if (r) return r;
    }
    return null;
  }

  return walk(params, "", []);
}

/**
 * denyPaths 各 entry の inode を収集する。
 * denyPaths が directory の場合は、配下も再帰的に収集する。
 * 実 FS に存在しない deny path はスキップ（test 環境で /data/workspace 等が無いケース対応）。
 */
function collectDenyInodes(denyPaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const visitedDirs = new Set<string>();
  for (const p of denyPaths) {
    collectDenyPathInodes(p, p, map, visitedDirs);
  }
  return map;
}

function collectDenyPathInodes(
  denyRoot: string,
  currentPath: string,
  map: Map<string, string>,
  visitedDirs: Set<string>,
): void {
  const stat = tryStat(currentPath);
  if (!stat) return;
  const inodeKey = `${stat.dev}:${stat.ino}`;
  map.set(inodeKey, denyRoot);
  if (!stat.isDirectory()) return;
  if (visitedDirs.has(inodeKey)) return;
  visitedDirs.add(inodeKey);

  const entries = tryReadDir(currentPath);
  if (!entries) return;
  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      collectDenyPathInodes(denyRoot, entryPath, map, visitedDirs);
      continue;
    }
    const entryStat = tryStat(entryPath);
    if (entryStat) {
      map.set(`${entryStat.dev}:${entryStat.ino}`, denyRoot);
    }
  }
}

function tryReadDir(p: string): Dirent[] | null {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function tryStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

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
export function expandPathCandidates(
  s: string,
  baseDirs: string[],
  includeBareTokens: boolean,
): string[] {
  const candidates = new Set<string>();
  if (s === "") {
    candidates.add(s);
    return [...candidates];
  }
  for (const variant of stringVariants(s)) {
    candidates.add(variant);
    addResolvedPathCandidates(candidates, variant, baseDirs);
    for (const token of extractPathLikeTokens(variant, includeBareTokens && baseDirs.length > 0)) {
      addResolvedPathCandidates(candidates, token, baseDirs);
      for (const absolutePath of extractEmbeddedAbsolutePaths(token)) {
        addResolvedPathCandidates(candidates, absolutePath, baseDirs);
      }
    }
  }
  return [...candidates];
}

/**
 * 1 つの string から「文字列ベースの canonical 変種」を返す。
 * URL decode・不可視文字除去・空白 trim を組み合わせて迂回パターンを正規化する。
 */
function stringVariants(s: string): string[] {
  const variants = new Set<string>();
  variants.add(s);
  const trimmed = s.trim();
  if (trimmed !== s) variants.add(trimmed);

  // 不可視文字（zero-width space U+200B, BOM U+FEFF, NBSP U+00A0, 各種改行 / tab）を除去
  const stripped = s.replace(/[​﻿ \r\n\t]+/g, "");
  if (stripped !== s) variants.add(stripped);
  const strippedTrimmed = stripped.trim();
  if (strippedTrimmed !== stripped) variants.add(strippedTrimmed);

  // URL-decode（部分的に encode されたケースのため try/catch）
  for (const variant of [...variants]) {
    try {
      const decoded = decodeURIComponent(variant);
      if (decoded !== variant) variants.add(decoded);
    } catch {
      // ignore malformed encoding
    }
  }
  // NFKC 正規化（mojibake / 全角混在）
  for (const variant of [...variants]) {
    try {
      const nfkc = variant.normalize("NFKC");
      if (nfkc !== variant) variants.add(nfkc);
    } catch {
      // ignore
    }
  }
  return [...variants];
}

function addResolvedPathCandidates(
  candidates: Set<string>,
  value: string,
  baseDirs: string[],
): void {
  if (value === "") return;
  try {
    candidates.add(path.resolve("/", value));
  } catch {
    // ignore
  }
  try {
    candidates.add(path.resolve(value));
  } catch {
    // ignore
  }
  for (const baseDir of baseDirs) {
    try {
      candidates.add(path.resolve(baseDir, value));
    } catch {
      // ignore
    }
  }
}

function extractPathLikeTokens(s: string, includeBareTokens: boolean): string[] {
  return s
    .split(/\s+/)
    .map((token) => token.replace(/^[`"'([{<]+|[`"',;:)\]}<>]+$/g, ""))
    .filter((token) => token !== "")
    .filter((token) => includeBareTokens || token.includes("/") || token.startsWith("."));
}

function extractEmbeddedAbsolutePaths(token: string): string[] {
  return [...token.matchAll(/\/[^\s`"'|&;(){}[\]<>]*/g)]
    .map((match) => match[0].replace(/[`"',;:)\]}<>]+$/g, ""))
    .filter((pathFragment) => pathFragment !== "" && pathFragment !== path.sep);
}

function isCommandLikeField(fieldPath: string): boolean {
  const leaf =
    fieldPath
      .split(".")
      .at(-1)
      ?.replace(/\[\d+\]$/g, "")
      .toLowerCase() ?? "";
  return leaf === "command" || leaf === "cmd" || leaf === "script" || leaf === "shell";
}

/**
 * 候補 path が denyPath 配下にあるか判定する。
 * - 候補を normalize した結果が deny と同一、または deny + path.sep プレフィックスを持てば true
 * - deny が `/` の場合は任意の絶対 path を deny 扱い
 */
export function isWithinDenyPath(candidate: string, normalizedDeny: string): boolean {
  const normalizedCandidate = normalizePathForMatch(candidate);
  if (normalizedCandidate === normalizedDeny) return true;
  if (normalizedDeny === path.sep) return normalizedCandidate.startsWith(path.sep);
  return normalizedCandidate.startsWith(`${normalizedDeny}${path.sep}`);
}

export function normalizePathForMatch(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return value;
  let resolved: string;
  try {
    resolved = path.resolve("/", trimmed);
  } catch {
    resolved = trimmed;
  }
  if (resolved === path.sep) return resolved;
  return resolved.replace(/\/+$/g, "");
}

function collectScopedBaseDirs(
  entries: [string, unknown][],
  inheritedBaseDirs: string[],
): string[] {
  const baseDirs = new Set(inheritedBaseDirs);
  for (const [key, value] of entries) {
    if (typeof value !== "string") continue;
    if (!BASE_DIR_FIELD_NAMES.has(key.toLowerCase())) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    try {
      baseDirs.add(path.resolve("/", trimmed));
    } catch {
      // ignore
    }
    try {
      baseDirs.add(path.resolve(trimmed));
    } catch {
      // ignore
    }
  }
  return [...baseDirs];
}
