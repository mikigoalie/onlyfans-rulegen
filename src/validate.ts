import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { validateRulesShape } from "./shape";

const [rulesPath, samplePath] = process.argv.slice(2);
try {
  if (!rulesPath) throw new Error("Usage: validate <dynamic-rules.json> [<samples/obfuscated/revision.js>]");
  const rules = validateRulesShape(JSON.parse(readFileSync(rulesPath, "utf8")));
  if (samplePath && basename(samplePath, ".js") !== rules.revision) throw new Error(`${samplePath} does not match revision ${rules.revision}`);
  if (samplePath && !statSync(samplePath).size) throw new Error(`${samplePath} is empty`);
  console.log(`${rulesPath} is valid (revision ${rules.revision})`);
} catch (err) {
  console.error("Validation failed:", (err as Error).message);
  process.exit(1);
}
