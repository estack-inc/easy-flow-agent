import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCache,
  getFlowById,
  getFlowByTrigger,
  listFlows,
  loadFlowDefinitions,
} from "./flow-loader.js";

// テスト用の有効なフロー定義
const validFlow1 = {
  version: 1,
  flowId: "flow_alpha",
  trigger: "📋",
  label: "フローA",
  steps: [{ id: "step1", label: "ステップ1" }],
};

const validFlow2 = {
  version: 1,
  flowId: "flow_beta",
  trigger: "📢",
  label: "フローB",
  steps: [{ id: "step1", label: "ステップ1" }],
};

describe("flow-loader", () => {
  let tmpDir: string;
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-loader-test-"));
    _resetCache();
    logger.warn.mockClear();
    logger.info.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetCache();
  });

  // ===========================================================================
  // 正常系
  // ===========================================================================
  describe("正常系", () => {
    it("複数 JSON ファイルをアルファベット順で読み込む", () => {
      // b より a が先になるようファイル名を設定
      fs.writeFileSync(path.join(tmpDir, "a-flow.json"), JSON.stringify(validFlow1));
      fs.writeFileSync(path.join(tmpDir, "b-flow.json"), JSON.stringify(validFlow2));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(2);
      expect(flows[0].flowId).toBe("flow_alpha");
      expect(flows[1].flowId).toBe("flow_beta");
    });

    it("getFlowByTrigger で完全一致検索できる", () => {
      fs.writeFileSync(path.join(tmpDir, "flow.json"), JSON.stringify(validFlow1));
      loadFlowDefinitions(tmpDir, logger);

      const found = getFlowByTrigger("📋");
      expect(found).toBeDefined();
      expect(found?.flowId).toBe("flow_alpha");

      const notFound = getFlowByTrigger("🔴");
      expect(notFound).toBeUndefined();
    });

    it("getFlowById で検索できる", () => {
      fs.writeFileSync(path.join(tmpDir, "flow.json"), JSON.stringify(validFlow1));
      loadFlowDefinitions(tmpDir, logger);

      const found = getFlowById("flow_alpha");
      expect(found).toBeDefined();
      expect(found?.trigger).toBe("📋");

      const notFound = getFlowById("nonexistent");
      expect(notFound).toBeUndefined();
    });
  });

  // ===========================================================================
  // 異常系
  // ===========================================================================
  describe("異常系", () => {
    it("JSON パースエラーのファイルは警告して無視し、他は正常に読み込む", () => {
      fs.writeFileSync(path.join(tmpDir, "a-bad.json"), "{ invalid json !!!");
      fs.writeFileSync(path.join(tmpDir, "b-good.json"), JSON.stringify(validFlow1));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].flowId).toBe("flow_alpha");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("JSON パースエラー"));
    });

    it("BOM 付き UTF-8 ファイルは BOM 除去後にパース成功", () => {
      const bom = "\uFEFF";
      fs.writeFileSync(path.join(tmpDir, "bom-flow.json"), bom + JSON.stringify(validFlow1));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].flowId).toBe("flow_alpha");
    });

    it("flowId 重複: アルファベット順で先のファイルが有効", () => {
      const duplicateFlow = { ...validFlow2, flowId: "flow_alpha" }; // flowId を同じにする
      fs.writeFileSync(path.join(tmpDir, "a-first.json"), JSON.stringify(validFlow1));
      fs.writeFileSync(path.join(tmpDir, "b-second.json"), JSON.stringify(duplicateFlow));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].trigger).toBe("📋"); // a-first.json のもの
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("flowId"));
    });

    it("trigger 重複: アルファベット順で先のファイルが有効", () => {
      const duplicateFlow = { ...validFlow2, trigger: "📋" }; // trigger を同じにする
      fs.writeFileSync(path.join(tmpDir, "a-first.json"), JSON.stringify(validFlow1));
      fs.writeFileSync(path.join(tmpDir, "b-second.json"), JSON.stringify(duplicateFlow));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].flowId).toBe("flow_alpha"); // a-first.json のもの
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("trigger"));
    });

    it("ディレクトリが不在の場合は空配列を返す", () => {
      const flows = loadFlowDefinitions("/nonexistent/path/xyz", logger);
      expect(flows).toHaveLength(0);
    });

    it(".json 以外のファイル（.bak）は無視する", () => {
      fs.writeFileSync(path.join(tmpDir, "flow.json"), JSON.stringify(validFlow1));
      fs.writeFileSync(path.join(tmpDir, "flow.json.bak"), JSON.stringify(validFlow2));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].flowId).toBe("flow_alpha");
    });

    it("不正ファイルが他の正常ファイルの読み込みを阻害しない", () => {
      fs.writeFileSync(
        path.join(tmpDir, "a-invalid.json"),
        JSON.stringify({ flowId: "InvalidId", trigger: "x", label: "test", steps: [] }),
      );
      fs.writeFileSync(path.join(tmpDir, "b-valid.json"), JSON.stringify(validFlow1));

      const flows = loadFlowDefinitions(tmpDir, logger);
      expect(flows).toHaveLength(1);
      expect(flows[0].flowId).toBe("flow_alpha");
    });
  });

  // ===========================================================================
  // listFlows
  // ===========================================================================
  describe("listFlows", () => {
    it("読み込み済みの全フロー定義を返す", () => {
      fs.writeFileSync(path.join(tmpDir, "a.json"), JSON.stringify(validFlow1));
      fs.writeFileSync(path.join(tmpDir, "b.json"), JSON.stringify(validFlow2));
      loadFlowDefinitions(tmpDir, logger);

      const flows = listFlows();
      expect(flows).toHaveLength(2);
    });

    it("返り値は元のキャッシュのコピーである", () => {
      fs.writeFileSync(path.join(tmpDir, "a.json"), JSON.stringify(validFlow1));
      loadFlowDefinitions(tmpDir, logger);

      const flows1 = listFlows();
      const flows2 = listFlows();
      expect(flows1).not.toBe(flows2); // 別の配列インスタンス
      expect(flows1).toEqual(flows2); // 内容は同じ
    });
  });
});
