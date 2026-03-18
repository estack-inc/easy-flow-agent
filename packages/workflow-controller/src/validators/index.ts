export * from "./types.js";

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPrompt(name: string): string {
  return readFileSync(join(__dirname, `${name}.md`), "utf-8");
}

export const validatorPrompts = {
  requirements: readPrompt("requirements"),
  design: readPrompt("design"),
  task: readPrompt("task"),
  outputReview: readPrompt("output-review"),
} as const;
