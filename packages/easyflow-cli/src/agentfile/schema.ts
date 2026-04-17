import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const agentfileSchema = JSON.parse(
  readFileSync(join(__dirname, "../../schema/agentfile.schema.json"), "utf-8"),
);
