import * as fs from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";
import { EasyflowError } from "../utils/errors.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT_PATTERN = /^(?:export\s+)?([^=\s]+)\s*=/;

/**
 * .env 形式のシークレットファイルをパースして Record<string, string> を返す。
 */
export async function loadSecretFile(filePath: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new EasyflowError(
        `シークレットファイルが見つかりません: ${filePath}`,
        "ENOENT",
        "ファイルパスを確認してください",
      );
    }
    throw err;
  }

  const lines = content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    // 空行・コメント行をスキップ
    if (!line || line.startsWith("#")) {
      continue;
    }

    const assignmentMatch = line.match(ASSIGNMENT_PATTERN);
    if (!assignmentMatch) {
      throw new EasyflowError(
        `シークレットファイルの形式が不正です: ${index + 1} 行目`,
        "`KEY=VALUE` 形式で指定してください",
        "dotenv 互換の `KEY=VALUE` または `export KEY=VALUE` 形式で指定してください",
      );
    }

    const key = assignmentMatch[1];

    if (!KEY_PATTERN.test(key)) {
      throw new EasyflowError(
        `無効なキー名: "${key}"`,
        "キーは [A-Za-z_][A-Za-z0-9_]* のパターンに一致する必要があります",
        "シークレットファイルのキー名を修正してください",
      );
    }
  }

  const result = parseDotenv(content);
  for (const key of Object.keys(result)) {
    if (!KEY_PATTERN.test(key)) {
      throw new EasyflowError(
        `無効なキー名: "${key}"`,
        "キーは [A-Za-z_][A-Za-z0-9_]* のパターンに一致する必要があります",
        "シークレットファイルのキー名を修正してください",
      );
    }
  }

  return result;
}
