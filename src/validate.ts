import { readFileSync } from "fs";
import { validateRulesShape } from "./shape";

const [rulesPath] = process.argv.slice(2);
try {
  if (!rulesPath) throw new Error("Usage: validate <dynamic-rules.json>");
  const rules = validateRulesShape(JSON.parse(readFileSync(rulesPath, "utf8")));
  console.log(`${rulesPath} is valid (revision ${rules.revision})`);
} catch (err) {
  console.error("Validation failed:", (err as Error).message);
  process.exit(1);
}
