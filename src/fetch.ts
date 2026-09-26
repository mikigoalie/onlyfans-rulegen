import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getRules } from "./rules";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SCRIPT_RE = /https:\/\/static2\.onlyfans\.com\/static\/prod\/[a-f0-9]\/(202[567]\d{8}-[a-f0-9]{10})\/([a-f0-9]{4})\.js/;

function curl(url: string): string {
  try {
    return execFileSync("curl", ["-sL", "--fail", "--max-time", "60", "-A", UA, url], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  } catch (err: any) {
    throw new Error(`curl failed for ${url}: ${err.message}`);
  }
}

try {
  console.error("Fetching https://onlyfans.com ...");
  const home = curl("https://onlyfans.com");
  const match = home.match(SCRIPT_RE);
  if (!match)
    throw new Error(/cloudflare|just a moment|challenge-platform/i.test(home)
      ? "Blocked by Cloudflare — no signing script URL in the homepage. Retry, or run the GitHub Actions workflow (it uses curl-impersonate)."
      : "Could not find the signing script URL on the homepage");
  const [scriptUrl, revision] = match;
  console.error(`Revision:  ${revision}\nScript:    ${scriptUrl}`);
  const scriptSrc = curl(scriptUrl);
  console.error("Fetching app.js for app_token ...");
  const appToken = curl(`${scriptUrl.slice(0, scriptUrl.lastIndexOf("/"))}/app.js`).match(/,\s*[A-Za-z_$]{1,3}\s*=\s*"([a-f0-9]{32})"/)?.[1];
  if (!appToken) throw new Error("Could not extract app_token from app.js");
  console.error(`app_token: ${appToken}`);
  const samplePath = join("samples", "obfuscated", `${revision}.js`);
  mkdirSync(join("samples", "obfuscated"), { recursive: true });
  writeFileSync(samplePath, scriptSrc);
  console.error(`Saved      ${samplePath}`);
  const json = JSON.stringify(getRules(scriptSrc, appToken, revision), null, 2);
  writeFileSync("dynamic-rules.json", json + "\n");
  console.error("Wrote      dynamic-rules.json");
  console.log(json);
} catch (err) {
  console.error("Fetch failed:", (err as Error).message);
  process.exit(1);
}
