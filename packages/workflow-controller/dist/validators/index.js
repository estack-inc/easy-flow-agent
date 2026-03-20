import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export * from "./types.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
function readPrompt(name) {
  return readFileSync(join(__dirname, `${name}.md`), "utf-8");
}
const validatorPrompts = {
  requirements: readPrompt("requirements"),
  design: readPrompt("design"),
  task: readPrompt("task"),
  outputReview: readPrompt("output-review")
};
export {
  validatorPrompts
};
