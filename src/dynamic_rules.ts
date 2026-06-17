import { readFileSync } from "fs";
import { basename } from "path";
import { getRules } from "./rules";

const filePath = process.argv[2];
const appToken = process.argv[3];

if (!filePath || !appToken) {
  console.error("Usage: dynamic_rules <obfuscated-script.js> <app_token>");
  process.exit(1);
}

try {
  const source = readFileSync(filePath, "utf8");
  const rules = getRules(source, appToken, basename(filePath, ".js"));
  console.log(JSON.stringify(rules, null, 2));
} catch (err) {
  console.error("Failed to generate dynamic rules:", (err as Error).message);
  process.exit(1);
}
