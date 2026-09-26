import { createHash, randomInt } from "crypto";
import { checksumHex, DynamicRules, validateRulesShape } from "./shape";
import { findSigner, loadScript } from "./rules";

/**
 * Checks extracted rules against the real sign module.
 *
 * Loads the script again in a fresh sandbox, this time with a real SHA-1 and
 * a real `get`, signs `samples` random paths as random non-zero users, and
 * checks every result against what the rules predict. Throws on the first
 * mismatch; returns the number of verified calls.
 */
export function verifyRules(
  source: string,
  rules: DynamicRules,
  { samples = 500 }: { samples?: number } = {}
): number {
  validateRulesShape(rules);

  let userId = 0;
  const signer = findSigner(loadScript(source), {
    hash: (input) => sha1(input),
    userId: () => userId,
  });

  for (let n = 0; n < samples; n++) {
    const path = randomPath();
    userId = randomInt(1, 2 ** 31);
    const ctx = `path=${JSON.stringify(path)} userId=${userId}`;
    const check = (what: string, expected: unknown, actual: unknown) => {
      if (expected !== actual) {
        throw new Error(
          `Verification failed (${what}) for ${ctx}: ` +
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
      }
    };

    const call = signer(path);
    check("hash calls per sign", 1, call.hashInputs.length);

    const message = [rules.static_param, call.time, path, userId].join("\n");
    check("hashed message", message, call.hashInputs[0]);
    check("time", String(call.time), call.hashInputs[0].split("\n")[1]);

    const hash = sha1(message);
    const parts = call.sign.split(":");
    check("sign field count", 4, parts.length);
    check("prefix", rules.prefix, parts[0]);
    check("hash", hash, parts[1]);
    check("checksum", checksumHex(hash, rules), parts[2]);
    check("suffix", rules.suffix, parts[3]);
  }
  return samples;
}

function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

const ALPHABETS = [
  "abcdefghijklmnopqrstuvwxyz0123456789",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ-_.~",
  "%&=+,;:@!$'()*",
  "äöüßéèñçøå",
  "日本語中文한국어",
  "😀🚀🔥👍🏽",
];

function randomString(maxLen: number): string {
  const len = randomInt(0, maxLen + 1);
  const alphabet = [...ALPHABETS[randomInt(0, ALPHABETS.length)]];
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[randomInt(0, alphabet.length)];
  return s;
}

/** A random API-ish path: varied length, optional query string, unicode. */
function randomPath(): string {
  const kind = randomInt(0, 10);
  if (kind === 0) return "";
  if (kind === 1) return "/";
  let path = "/api2/v2";
  const segments = randomInt(0, 8);
  for (let i = 0; i < segments; i++) path += "/" + randomString(24);
  if (randomInt(0, 2) === 1) {
    const params: string[] = [];
    const count = randomInt(1, 6);
    for (let i = 0; i < count; i++) {
      params.push(`${randomString(10)}=${randomString(30)}`);
    }
    path += "?" + params.join("&");
  }
  return path;
}
