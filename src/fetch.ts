import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getRules } from "./rules";

/**
 * Fetches the current OnlyFans signing chunk + app token and regenerates
 * dynamic-rules.json in one shot.
 *
 * Cloudflare blocks Node's built-in fetch via TLS fingerprinting, so we shell
 * out to the system `curl` (which presents an accepted fingerprint). On CI the
 * dedicated workflow uses curl-impersonate instead; this is the local helper.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SCRIPT_RE =
  /https:\/\/static2\.onlyfans\.com\/static\/prod\/[a-f0-9]\/(202[567]\d{8}-[a-f0-9]{10})\/([a-f0-9]{4})\.js/;

function curl(url: string): string {
  try {
    return execFileSync(
      "curl",
      ["-sL", "--fail", "--max-time", "60", "-A", UA, url],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
    );
  } catch (err: any) {
    throw new Error(`curl failed for ${url}: ${err.message}`);
  }
}

function main(): void {
  console.error("Fetching https://onlyfans.com ...");
  const home = curl("https://onlyfans.com");

  const match = home.match(SCRIPT_RE);
  if (!match) {
    if (/cloudflare|just a moment|challenge-platform/i.test(home)) {
      throw new Error(
        "Blocked by Cloudflare — no signing script URL in the homepage. " +
          "Retry, or run the GitHub Actions workflow (it uses curl-impersonate)."
      );
    }
    throw new Error("Could not find the signing script URL on the homepage");
  }

  const scriptUrl = match[0];
  const revision = match[1];
  const baseDir = scriptUrl.slice(0, scriptUrl.lastIndexOf("/"));
  console.error(`Revision:  ${revision}`);
  console.error(`Script:    ${scriptUrl}`);

  const scriptSrc = curl(scriptUrl);

  console.error("Fetching app.js for app_token ...");
  const appJs = curl(`${baseDir}/app.js`);
  // Matches minified assignments like: ,Pe="33d57ade8c02dbc5a333db99ff9ae26a"
  const tokenMatch = appJs.match(/,\s*[A-Za-z_$]{1,3}\s*=\s*"([a-f0-9]{32})"/);
  if (!tokenMatch) {
    throw new Error("Could not extract app_token from app.js");
  }
  const appToken = tokenMatch[1];
  console.error(`app_token: ${appToken}`);

  // Keep the raw chunk around as a sample / test fixture.
  const outDir = join("samples", "obfuscated");
  mkdirSync(outDir, { recursive: true });
  const samplePath = join(outDir, `${revision}.js`);
  writeFileSync(samplePath, scriptSrc);
  console.error(`Saved      ${samplePath}`);

  const rules = getRules(scriptSrc, appToken, revision);
  writeFileSync("dynamic-rules.json", JSON.stringify(rules, null, 2) + "\n");
  console.error("Wrote      dynamic-rules.json");
  console.log(JSON.stringify(rules, null, 2));
}

try {
  main();
} catch (err) {
  console.error("Fetch failed:", (err as Error).message);
  process.exit(1);
}
