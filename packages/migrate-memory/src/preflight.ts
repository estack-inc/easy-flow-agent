import { readFile } from "node:fs/promises";

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "GitHub PAT", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: "GitLab PAT", pattern: /glpat-[A-Za-z0-9-]{20}/ },
  { name: "Slack Webhook URL", pattern: /hooks\.slack\.com\/services\// },
  { name: "PW直書き", pattern: /PW:\s*\S+/i },
  { name: "パスワード直書き", pattern: /パスワード[：:]\s*\S+/ },
  { name: "password直書き", pattern: /password[：:=]\s*\S+/i },
  { name: "類似パスワード", pattern: /kY\d\d[a-zA-Z]/ },
];

const MIN_LINES = 5;
const MAX_LINES = 200;

export interface PreflightResult {
  file: string;
  secrets: string[];
  warnings: string[];
}

export async function runPreflight(files: string[]): Promise<{
  results: PreflightResult[];
  hasSecrets: boolean;
}> {
  const results: PreflightResult[] = [];
  let hasSecrets = false;

  for (const file of files) {
    const result: PreflightResult = { file, secrets: [], warnings: [] };

    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line) && !result.secrets.includes(name)) {
          result.secrets.push(name);
        }
      }
    }

    if (result.secrets.length > 0) {
      hasSecrets = true;
    }

    const lineCount = lines.length;
    if (lineCount < MIN_LINES) {
      result.warnings.push("情報密度が低く参照されにくい可能性があります");
    }
    if (lineCount > MAX_LINES) {
      result.warnings.push("チャンク分割で文脈が切れる可能性があります。ファイル分割を推奨します");
    }

    results.push(result);
  }

  return { results, hasSecrets };
}
