import * as fs from "node:fs/promises";
import { EasyflowError } from "../utils/errors.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // 空行・コメント行をスキップ
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (!KEY_PATTERN.test(key)) {
      throw new EasyflowError(
        `無効なキー名: "${key}"`,
        "キーは [A-Za-z_][A-Za-z0-9_]* のパターンに一致する必要があります",
        "シークレットファイルのキー名を修正してください",
      );
    }

    // 前後の二重引用符を除去
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
