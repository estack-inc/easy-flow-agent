import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAgentfile } from "../../src/agentfile/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "../../bundled-templates");

const BUNDLED_TEMPLATES = ["monitor", "executive-assistant"] as const;

describe("バンドルされたテンプレート", () => {
  for (const name of BUNDLED_TEMPLATES) {
    it(`${name}.yaml が parseAgentfile でバリデーション成功する`, async () => {
      const templatePath = resolve(TEMPLATES_DIR, `${name}.yaml`);
      const content = readFileSync(templatePath, "utf-8");
      const result = await parseAgentfile(content, {
        basedir: TEMPLATES_DIR,
        templatePaths: [],
      });

      expect(result.agentfile.apiVersion).toBe("easyflow/v1");
      expect(result.agentfile.kind).toBe("Agent");
      expect(result.agentfile.metadata.name).toBe(name);
      expect(result.agentfile.identity.soul.length).toBeGreaterThan(0);
      expect(result.agentfile.tools?.builtin).toContain("workflow-controller");
      const hasEnabledChannel = Object.values(result.agentfile.channels ?? {}).some(
        (ch) => ch?.enabled,
      );
      expect(hasEnabledChannel).toBe(true);
      // バンドル配置用の制約: AGENTS.md / AGENTS-CORE.md への相対参照は持たない
      expect(result.agentfile.knowledge).toBeUndefined();
      expect(result.agentfile.agents_core).toBeUndefined();
    });
  }
});
