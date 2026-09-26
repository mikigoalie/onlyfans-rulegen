import { createHash, randomInt } from "crypto";
import { checksumHex, DynamicRules, validateRulesShape } from "./shape";
import { findSigner, loadScript } from "./sandbox";

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");
const pick = <T>(a: T[]) => a[randomInt(0, a.length)];
const ALPHABETS = ["abcdefghijklmnopqrstuvwxyz0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ-_.~", "%&=+,;:@!$'()*", "äöüßéèñçøå", "日本語中文한국어", "😀🚀🔥👍🏽"].map((a) => [...a]);
const randomString = (max: number) => {
  const a = pick(ALPHABETS);
  return Array.from({ length: randomInt(0, max + 1) }, () => pick(a)).join("");
};
const randomPath = () => {
  const kind = randomInt(0, 10);
  if (kind < 2) return ["", "/"][kind];
  const path = "/api2/v2" + Array.from({ length: randomInt(0, 8) }, () => "/" + randomString(24)).join("");
  return randomInt(0, 2) ? path : path + "?" + Array.from({ length: randomInt(1, 6) }, () => `${randomString(10)}=${randomString(30)}`).join("&");
};

export function verifyRules(source: string, rules: DynamicRules, { samples = 500 }: { samples?: number } = {}): number {
  validateRulesShape(rules);
  let userId = 0;
  const signer = findSigner(loadScript(source), { hash: sha1, userId: () => userId });
  for (let n = 0; n < samples; n++) {
    const path = randomPath();
    userId = randomInt(1, 2 ** 31);
    const check = (what: string, expected: unknown, actual: unknown) => {
      if (expected !== actual)
        throw new Error(`Verification failed (${what}) for path=${JSON.stringify(path)} userId=${userId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
