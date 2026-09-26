import { readFileSync } from "fs";
import { basename } from "path";
import { getRules } from "./rules";

const [filePath, appToken] = process.argv.slice(2);
if (!filePath || !appToken) {
  console.error("Usage: dynamic_rules <obfuscated-script.js> <app_token>");
  process.exit(1);
}
try {
  console.log(JSON.stringify(getRules(readFileSync(filePath, "utf8"), appToken, basename(filePath, ".js")), null, 2));
} catch (err) {
  console.error("Failed to generate dynamic rules:", (err as Error).message);
  process.exit(1);
}
