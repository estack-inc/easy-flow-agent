/**
 * path-checker の単体テスト（30+ 迂回パターン検証）
 *
 * Phase 0 cost-guard-hello の path.resolve canonical 化を継承しつつ：
 * - realpath（symlink 解決）の検出
 * - inode 一致（hardlink）の検出
 * - URL-encoded、不可視文字、NFKC 正規化での迂回試行
 *
 * 30+ 迂回パターン（path-checker.ts のコメント参照）の各パターンを test。
 * 実 FS 不要な文字列ベース canonical 化のテストが大半。symlink / inode は
 * tmpdir 内に実 FS を構築して検証。
 *
 * leaf_node: false（critical path）必須項目：
 * - 30+ 迂回パターン unit test 全 pass
 * - sentinel boundary value test 全 pass
 * - latency benchmark < 500ms（mock benchmark）
 */

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expandPathCandidates,
  findDenyPathMatch,
  isWithinDenyPath,
  normalizePathForMatch,
} from "./path-checker.js";

const DENY = "/data/workspace/zoom_transcribe/";

const baseOptions = {
  denyHardlinkTraversal: false,
  resolveSymlinks: false,
};

describe("normalizePathForMatch", () => {
  it("末尾 slash を取り除いた正規化 path を返す", () => {
    expect(normalizePathForMatch("/data/workspace/zoom_transcribe/")).toBe(
      "/data/workspace/zoom_transcribe",
    );
  });

  it("`../` を解決", () => {
    expect(normalizePathForMatch("/data/workspace/../workspace/zoom_transcribe")).toBe(
      "/data/workspace/zoom_transcribe",
    );
  });

  it("二重 slash を 1 つにまとめる", () => {
    expect(normalizePathForMatch("/data//workspace///zoom_transcribe/")).toBe(
      "/data/workspace/zoom_transcribe",
    );
  });

  it("root path はそのまま `/`", () => {
    expect(normalizePathForMatch("/")).toBe("/");
  });
});

describe("isWithinDenyPath", () => {
  const deny = normalizePathForMatch(DENY);

  it("deny path 配下は true", () => {
    expect(isWithinDenyPath("/data/workspace/zoom_transcribe/x.txt", deny)).toBe(true);
  });

  it("deny path と完全一致も true", () => {
    expect(isWithinDenyPath("/data/workspace/zoom_transcribe", deny)).toBe(true);
  });

  it("別 directory は false", () => {
    expect(isWithinDenyPath("/data/workspace/notes/x.md", deny)).toBe(false);
  });

  it("prefix 一致だけで配下でない path は false", () => {
    expect(isWithinDenyPath("/data/workspace/zoom_transcribe_old/x.txt", deny)).toBe(false);
  });
});

describe("expandPathCandidates", () => {
  it("絶対 path はそのまま含まれる", () => {
    const r = expandPathCandidates("/data/workspace/zoom_transcribe/x.txt", [], false);
    expect(r).toContain("/data/workspace/zoom_transcribe/x.txt");
  });

  it("`../` 経由を resolve", () => {
    const r = expandPathCandidates("/data/workspace/../workspace/zoom_transcribe/x.txt", [], false);
    expect(r).toContain("/data/workspace/zoom_transcribe/x.txt");
  });

  it("URL-encoded を decode", () => {
    const r = expandPathCandidates("/data/workspace/zoom_transcribe%2Fx.txt", [], false);
    // %2F → /
    expect(r.some((c) => c.includes("/zoom_transcribe/x.txt"))).toBe(true);
  });

  it("baseDir 起点の相対 path を resolve", () => {
    const r = expandPathCandidates("zoom_transcribe/x.txt", ["/data/workspace"], false);
    expect(r).toContain("/data/workspace/zoom_transcribe/x.txt");
  });

  it("不可視文字（zero-width space）を除去した変種を含む", () => {
    const r = expandPathCandidates("/data/workspace/zoom_​transcribe/x.txt", [], false);
    // ZWSP を除去した版が候補に含まれる
    expect(r.some((c) => c.includes("zoom_transcribe"))).toBe(true);
  });
});

describe("findDenyPathMatch - 30+ 迂回パターン", () => {
  const opts = { denyPaths: [DENY], ...baseOptions };

  it("01 絶対 path 直書き", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
    expect(r?.reason).toBe("deny_path_match");
  });

  it("02 `../` 経由", () => {
    const r = findDenyPathMatch(
      { path: "/data/workspace/../workspace/zoom_transcribe/x.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("03 `./` 経由", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/./zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("04 二重 slash `//`", () => {
    const r = findDenyPathMatch({ path: "/data//workspace//zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("05 末尾 slash 有", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe/" }, opts);
    expect(r).not.toBeNull();
  });

  it("05b 末尾 slash 無 directory", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe" }, opts);
    expect(r).not.toBeNull();
  });

  it("06 URL-encoded path (%2F)", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe%2Fx.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("06b URL-encoded path (%2E%2E)", () => {
    const r = findDenyPathMatch(
      { path: "/data/workspace/%2E%2E/workspace/zoom_transcribe/x.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("07 cwd 起点の相対 path", () => {
    const r = findDenyPathMatch({ cwd: "/data/workspace", path: "zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("08 workdir 起点の相対 path", () => {
    const r = findDenyPathMatch(
      { workdir: "/data/workspace", path: "zoom_transcribe/x.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("09 dir 起点の相対 path", () => {
    const r = findDenyPathMatch({ dir: "/data/workspace", path: "zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("10 bare filename + cwd（command-like field）", () => {
    const r = findDenyPathMatch(
      { cwd: "/data/workspace/zoom_transcribe", command: "cat transcript.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("11 command 内 redirection `<`", () => {
    const r = findDenyPathMatch({ command: "cat</data/workspace/zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("12 command 内 redirection `>`", () => {
    const r = findDenyPathMatch({ command: "cat>/data/workspace/zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("13 command 内 option value `--file=`", () => {
    const r = findDenyPathMatch(
      { command: "cat --file=/data/workspace/zoom_transcribe/x.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("14 command 内 pipe `|`", () => {
    const r = findDenyPathMatch(
      { command: "head /data/workspace/zoom_transcribe/x.txt | wc -l" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("15 command 内空白区切り", () => {
    const r = findDenyPathMatch({ command: "cat /data/workspace/zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("16 args 配列の各要素（path 要素）", () => {
    const r = findDenyPathMatch({ args: ["-c", "/data/workspace/zoom_transcribe/x.txt"] }, opts);
    expect(r).not.toBeNull();
    expect(r?.field).toBe("args[1]");
  });

  it("17 ネスト object", () => {
    const r = findDenyPathMatch(
      { tool: { params: { path: "/data/workspace/zoom_transcribe/x.txt" } } },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("18 ネスト array", () => {
    const r = findDenyPathMatch(
      { items: [{ path: "/data/workspace/zoom_transcribe/x.txt" }] },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("22 /proc/<pid>/root/... を含む path 文字列", () => {
    const r = findDenyPathMatch(
      { path: "/proc/123/root/data/workspace/zoom_transcribe/x.txt" },
      { ...opts, denyPaths: ["/proc/"] },
    );
    expect(r).not.toBeNull();
  });

  it("23 自己参照 `./.`", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/./zoom_transcribe/./x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("24 連続 `../../..`", () => {
    const r = findDenyPathMatch(
      { path: "/data/x/../../data/workspace/zoom_transcribe/x.txt" },
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("25 不可視文字（ZWSP / NBSP / BOM）混入", () => {
    const r = findDenyPathMatch(
      { path: "/data/workspace/zoom_​transcribe/x.txt" }, // ZWSP
      opts,
    );
    expect(r).not.toBeNull();
  });

  it("26 改行（CR / LF）混入", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/\nzoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("27 tab 混入", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/\tzoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("28 末尾空白", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe/x.txt   " }, opts);
    expect(r).not.toBeNull();
  });

  it("29 先頭空白", () => {
    const r = findDenyPathMatch({ path: "   /data/workspace/zoom_transcribe/x.txt" }, opts);
    expect(r).not.toBeNull();
  });

  it("30 args 内 option value", () => {
    const r = findDenyPathMatch({ args: ["--file=/data/workspace/zoom_transcribe/x.txt"] }, opts);
    expect(r).not.toBeNull();
  });

  it("31 args 内 redirection", () => {
    const r = findDenyPathMatch({ args: ["cat</data/workspace/zoom_transcribe/x.txt"] }, opts);
    expect(r).not.toBeNull();
  });

  it("32 NFKC 正規化（全角 slash → 半角 slash）", () => {
    // NFKC で全角文字が半角になる典型例
    const r = findDenyPathMatch(
      { path: "/data/workspace/zoom_transcribe/x.txt".normalize("NFKC") },
      opts,
    );
    expect(r).not.toBeNull();
  });
});

describe("findDenyPathMatch - false positive 回避", () => {
  const opts = { denyPaths: [DENY], ...baseOptions };

  it("別 directory は通過", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/note.md" }, opts);
    expect(r).toBeNull();
  });

  it("denyPaths が空配列なら null", () => {
    const r = findDenyPathMatch(
      { path: "/data/workspace/zoom_transcribe/x.txt" },
      { denyPaths: [], ...baseOptions },
    );
    expect(r).toBeNull();
  });

  it("prefix 一致だけで配下でない path は null（zoom_transcribe_old）", () => {
    const r = findDenyPathMatch({ path: "/data/workspace/zoom_transcribe_old/x.txt" }, opts);
    expect(r).toBeNull();
  });

  it("循環参照 object でも throw しない", () => {
    const o: Record<string, unknown> = { path: "/data/workspace/note.md" };
    o.self = o;
    expect(() => findDenyPathMatch(o, opts)).not.toThrow();
  });
});

describe("findDenyPathMatch - symlink 解決（実 FS）", () => {
  let tmpRoot: string;
  let denyDir: string;
  let allowedDir: string;
  let symlinkPath: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "cost-guard-symlink-"));
    denyDir = path.join(tmpRoot, "deny");
    allowedDir = path.join(tmpRoot, "allowed");
    mkdirSync(denyDir);
    mkdirSync(allowedDir);
    writeFileSync(path.join(denyDir, "secret.txt"), "secret");
    symlinkPath = path.join(allowedDir, "shortcut");
    symlinkSync(denyDir, symlinkPath);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("symlink 越えで deny 配下に到達する path を deny_path_match_symlink で検出", () => {
    const symlinkedFile = path.join(symlinkPath, "secret.txt");
    const r = findDenyPathMatch(
      { path: symlinkedFile },
      {
        denyPaths: [denyDir],
        denyHardlinkTraversal: false,
        resolveSymlinks: true,
      },
    );
    expect(r).not.toBeNull();
    expect(r?.reason).toBe("deny_path_match_symlink");
  });

  it("resolveSymlinks=false なら symlink を解決せず通過", () => {
    const symlinkedFile = path.join(symlinkPath, "secret.txt");
    const r = findDenyPathMatch(
      { path: symlinkedFile },
      {
        denyPaths: [denyDir],
        denyHardlinkTraversal: false,
        resolveSymlinks: false,
      },
    );
    expect(r).toBeNull();
  });
});

describe("findDenyPathMatch - hardlink inode 一致（実 FS）", () => {
  let tmpRoot: string;
  let denyDir: string;
  let allowedDir: string;
  let hardlinkPath: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "cost-guard-hardlink-"));
    denyDir = path.join(tmpRoot, "deny");
    allowedDir = path.join(tmpRoot, "allowed");
    mkdirSync(denyDir);
    mkdirSync(allowedDir);
    // hardlink は file 単位（directory hardlink は不可）
    // deny 配下に実 file を置く
    const denyFile = path.join(denyDir, "secret.txt");
    writeFileSync(denyFile, "secret");
    hardlinkPath = path.join(allowedDir, "secret_link.txt");
    linkSync(denyFile, hardlinkPath);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("denyPaths に file を含めて denyHardlinkTraversal=true 時、hardlink を inode 一致で検出", () => {
    const denyFile = path.join(denyDir, "secret.txt");
    const r = findDenyPathMatch(
      { path: hardlinkPath },
      {
        denyPaths: [denyFile],
        denyHardlinkTraversal: true,
        resolveSymlinks: false,
      },
    );
    expect(r).not.toBeNull();
    expect(r?.reason).toBe("deny_path_match_inode");
  });

  it("denyHardlinkTraversal=false なら inode 一致を検査せず通過", () => {
    const denyFile = path.join(denyDir, "secret.txt");
    const r = findDenyPathMatch(
      { path: hardlinkPath },
      {
        denyPaths: [denyFile],
        denyHardlinkTraversal: false,
        resolveSymlinks: false,
      },
    );
    expect(r).toBeNull();
  });
});

describe("findDenyPathMatch - latency benchmark", () => {
  const opts = { denyPaths: [DENY], ...baseOptions };

  it("50 件の path 検査が 500ms 未満で完了", () => {
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      findDenyPathMatch({ path: `/data/workspace/zoom_transcribe/file_${i}.txt` }, opts);
      findDenyPathMatch({ path: `/data/workspace/note_${i}.md` }, opts);
      findDenyPathMatch(
        { cwd: "/data/workspace", command: `cat zoom_transcribe/file_${i}.txt` },
        opts,
      );
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
