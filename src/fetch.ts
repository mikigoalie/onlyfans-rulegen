import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { getRules } from "./rules";

export const SCRIPT_RE = /https:\/\/static2\.onlyfans\.com\/static\/prod\/[a-f0-9]\/(20\d{2}\d{8}-[a-f0-9]{10})\/[a-f0-9]{4}\.js/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TOKEN_REF = `([A-Za-z_$][\\w$]*|["'][a-f0-9]{32}["'])`;

export function parseHomepage(html: string) {
  const m = html.match(SCRIPT_RE);
  if (!m)
    throw new Error(/cloudflare|just a moment|challenge-platform/i.test(html)
      ? "Blocked by Cloudflare: no signing script URL in the homepage"
      : "Could not find the signing script URL on the homepage");
  return { scriptUrl: m[0], revision: m[1], appJsUrl: m[0].replace(/[^/]+$/, "app.js") };
}

export function extractAppToken(appJs: string): string {
  const ref = (appJs.match(new RegExp(`\\[\\s*["']app-token["']\\s*\\]\\s*=\\s*${TOKEN_REF}`)) ?? appJs.match(new RegExp(`["']app-token["']\\s*:\\s*${TOKEN_REF}`)))?.[1];
  if (!ref) throw new Error('Could not find where app.js sets the "app-token" header');
  if (/^["']/.test(ref)) return ref.slice(1, -1);
  const values = new Set([...appJs.matchAll(new RegExp(`(?<![\\w$.])${ref.replace(/\$/g, "\\$")}\\s*=\\s*["']([a-f0-9]{32})["']`, "g"))].map((m) => m[1]));
  if (values.size !== 1) throw new Error(`The "app-token" header is set from ${ref}, which is assigned ${values.size} different 32-hex values in app.js`);
  return [...values][0];
}

function main(args: string[]) {
  const opt = (name: string, def: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const curlBin = opt("--curl", process.env.CURL ?? "curl");
  const outDir = opt("--out", ".");
  const currentPath = opt("--current", "dynamic-rules.json");
  const output = (k: string, v: string) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  const warn = (msg: string) => console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `Warning: ${msg}`);
  const curl = (url: string) => {
    console.error(`GET ${url}`);
    return execFileSync(curlBin, ["-sSL", "--fail", "--max-time", "60", ...(basename(curlBin) === "curl" ? ["-A", UA] : []), url], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  };

  const current = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, "utf8")) : undefined;
  const { scriptUrl, revision, appJsUrl } = parseHomepage(curl("https://onlyfans.com"));
  console.error(`Revision: ${revision} (committed: ${current?.revision ?? "none"})`);
  output("revision", revision);
  if (!args.includes("--force") && current?.revision === revision) {
    console.error("Revision unchanged; nothing to do.");
    return output("changed", "false");
  }

  const source = curl(scriptUrl);
  const appToken = extractAppToken(curl(appJsUrl));
  if (current?.app_token && current.app_token !== appToken) warn(`app_token changed from ${current.app_token} to ${appToken}`);
  const rules = getRules(source, appToken, revision);
  if (rules.revision !== revision) throw new Error(`The chunk reports revision ${rules.revision} but its URL says ${revision}`);

  mkdirSync(join(outDir, "samples", "obfuscated"), { recursive: true });
  writeFileSync(join(outDir, "samples", "obfuscated", `${revision}.js`), source);
  writeFileSync(join(outDir, "dynamic-rules.json"), JSON.stringify(rules, null, 2) + "\n");
  console.error(`Wrote ${join(outDir, "dynamic-rules.json")} (verified ${rules.verified_samples} signatures)`);
  output("changed", "true");
}

if (require.main === module)
  try {
    main(process.argv.slice(2));
  } catch (err) {
    const msg = (err as Error).message;
    console.error("Fetch failed:", msg);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `error=Fetch failed: ${msg.replace(/\s+/g, " ")}\n`);
    process.exit(1);
  }
