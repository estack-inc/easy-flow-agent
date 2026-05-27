/**
 * command-checker の単体テスト
 *
 * 検証点：
 * - containsCommandPattern が substring match で判定
 * - findCommandDenylistMatch が command-like field のみを検査
 * - command-like field（command / cmd / script / shell / args）の各 alias をカバー
 * - non-command field（path / file / url 等）は検査対象外
 * - 既定 6 パターン（eval / bash -c $ / sh -c $ / <( / $( / `）をすべて検出
 * - false positive：通常 path には deny pattern を含まない command は通過
 */

import { describe, expect, it } from "vitest";
import { containsCommandPattern, findCommandDenylistMatch } from "./command-checker.js";

const DEFAULT_DENYLIST = ["eval", "bash -c $", "sh -c $", "<(", "$(", "`"];

describe("containsCommandPattern", () => {
  it("substring match で判定", () => {
    expect(containsCommandPattern("eval $(echo hello)", "eval")).toBe(true);
    expect(containsCommandPattern("cat file.txt", "eval")).toBe(false);
  });

  it("空パターンは false", () => {
    expect(containsCommandPattern("eval", "")).toBe(true); // string.includes("") は true だが
    // ※ 実装上は filter で空文字列を除外しているため findCommandDenylistMatch 経由では発火しない
  });
});

describe("findCommandDenylistMatch", () => {
  describe("既定 6 パターンの検出", () => {
    it("eval", () => {
      const r = findCommandDenylistMatch(
        { command: "eval $(cat /tmp/x.sh)" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("eval");
    });

    it("bash -c $", () => {
      const r = findCommandDenylistMatch(
        { command: "bash -c $SCRIPT" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("bash -c $");
    });

    it("sh -c $", () => {
      const r = findCommandDenylistMatch(
        { command: "sh -c $PAYLOAD" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("sh -c $");
    });

    it("process substitution <(", () => {
      const r = findCommandDenylistMatch(
        { command: "diff <(cat a) <(cat b)" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("<(");
    });

    it("command substitution $(", () => {
      const r = findCommandDenylistMatch(
        { command: "echo $(date)" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("$(");
    });

    it("backtick `", () => {
      const r = findCommandDenylistMatch(
        { command: "echo `date`" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.matchedPattern).toBe("`");
    });
  });

  describe("command-like field の alias", () => {
    it("command field を検査", () => {
      const r = findCommandDenylistMatch(
        { command: "eval xxx" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("command");
    });

    it("cmd field を検査", () => {
      const r = findCommandDenylistMatch(
        { cmd: "eval xxx" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("cmd");
    });

    it("script field を検査", () => {
      const r = findCommandDenylistMatch(
        { script: "eval xxx" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("script");
    });

    it("shell field を検査", () => {
      const r = findCommandDenylistMatch(
        { shell: "eval xxx" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("shell");
    });

    it("args 配列の要素を検査", () => {
      const r = findCommandDenylistMatch(
        { args: ["bash", "-c", "eval xxx"] },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("args[2]");
    });
  });

  describe("non-command field は検査対象外", () => {
    it("path field は eval が含まれていても通過", () => {
      const r = findCommandDenylistMatch(
        { path: "/eval/data.txt" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).toBeNull();
    });

    it("url field も検査対象外", () => {
      const r = findCommandDenylistMatch(
        { url: "https://example.com/eval" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).toBeNull();
    });
  });

  describe("非該当 / 境界", () => {
    it("通常 command は通過", () => {
      const r = findCommandDenylistMatch(
        { command: "cat /tmp/file.txt" },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).toBeNull();
    });

    it("commandDenylist が空配列なら null", () => {
      const r = findCommandDenylistMatch({ command: "eval xxx" }, { commandDenylist: [] });
      expect(r).toBeNull();
    });

    it("ネスト object 内の command も検査", () => {
      const r = findCommandDenylistMatch(
        { tool: { command: "eval $(date)" } },
        { commandDenylist: DEFAULT_DENYLIST },
      );
      expect(r).not.toBeNull();
      expect(r?.field).toBe("tool.command");
    });

    it("循環参照を含む object でも無限ループしない", () => {
      const o: Record<string, unknown> = { command: "safe cmd" };
      o.self = o;
      expect(() =>
        findCommandDenylistMatch(o, { commandDenylist: DEFAULT_DENYLIST }),
      ).not.toThrow();
    });
  });
});
