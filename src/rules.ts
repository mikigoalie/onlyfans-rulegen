import { readFileSync } from "fs";
import { join } from "path";
import { DynamicRules, HASH_LEN, validateRulesShape } from "./shape";
import { findSigner, loadScript, Signer } from "./sandbox";
import { verifyRules } from "./verify";

export { DynamicRules } from "./shape";

const fail = (msg: string): never => {
  throw new Error(msg);
};

function parseSign(sign: string, hash: string) {
  const at = sign.indexOf(`:${hash}:`);
  const [checksum, suffix, ...rest] = sign.slice(at + hash.length + 2).split(":");
  if (at < 0 || rest.length || suffix === undefined)
    fail(`Sign string does not carry the hash the module was given; the checksum may be computed over something other than the SHA-1: ${sign}`);
  if (!/^[0-9a-f]+$/.test(checksum)) fail(`Checksum ${JSON.stringify(checksum)} is not hex`);
  return { prefix: sign.slice(0, at), checksum, suffix };
}

function probeChecksum(signer: Signer, force: (h: string) => void) {
  const BASE = 500;
  const at = (changes: Record<number, number> = {}, path = "/api2/v2/probe", fill = BASE): number => {
    const codes = new Array(HASH_LEN).fill(fill);
    for (const [j, c] of Object.entries(changes)) codes[+j] = c;
    const hash = String.fromCharCode(...codes);
    force(hash);
    let call;
    try {
      call = signer(path);
    } catch (e) {
      return fail(`Sign function failed on a ${HASH_LEN}-character hash (does it read past position ${HASH_LEN - 1} or expect a different hash?): ${(e as Error).message}`);
    }
    if (call.hashInputs.length !== 1) fail(`Expected the module to hash exactly once per sign, saw ${call.hashInputs.length}`);
    return parseInt(parseSign(call.sign, hash).checksum, 16);
  };

  const c0 = at();
  if (at({}, "/api2/v2/other?x=1") !== c0) fail("Checksum changed with the path while the hash stayed fixed; it is not a function of the hash alone");

  const deltas = Array.from({ length: HASH_LEN }, (_, j) => {
    const d1 = at({ [j]: BASE + 1 }) - c0;
    if (!Number.isInteger(d1) || d1 < 0) fail(`Checksum delta at position ${j} is ${d1}, expected a non-negative integer`);
    const d2 = at({ [j]: BASE + 2 }) - c0;
    if (d2 !== 2 * d1) fail(`Checksum is not linear at position ${j}: +1 gave ${d1}, +2 gave ${d2}`);
    return d1;
  });

  for (let j = 0; j < HASH_LEN; j++)
    for (let k = j + 1; k < HASH_LEN; k++) {
      const d = at({ [j]: BASE + 1, [k]: BASE + 1 }) - c0;
      if (d !== deltas[j] + deltas[k]) fail(`Checksum is not additive at positions ${j},${k}: expected ${deltas[j] + deltas[k]}, got ${d}`);
    }

  const total = deltas.reduce((a, b) => a + b, 0);
  if (!total) fail("Checksum does not depend on the hash");
  const constant = c0 - BASE * total;
  const far = at({}, undefined, 700);
  if (far !== 700 * total + constant) fail(`Checksum model does not extrapolate: predicted ${700 * total + constant}, got ${far}`);

  return { indexes: deltas.flatMap((n, j) => Array(n).fill(j)), constant };
}

export function getRules(source: string, appToken: string, fallbackRevision: string): DynamicRules {
  const loaded = loadScript(source);
  let forced = "a".repeat(HASH_LEN);
  const signer = findSigner(loaded, { hash: () => forced, userId: () => 0 });
  const probe = signer("/api2/v2/probe");
  const { prefix, suffix } = parseSign(probe.sign, forced);
  const static_param = (probe.hashInputs[0] ?? "").split("\n")[0] || fail("Failed to capture static_param");
  const { indexes, constant } = probeChecksum(signer, (h) => (forced = h));

  const rules: DynamicRules = {
    end: suffix,
    start: prefix,
    format: `${prefix}:{}:{:x}:${suffix}`,
    prefix,
    suffix,
    revision: loaded.revision || fallbackRevision,
    app_token: appToken,
    static_param,
    remove_headers: ["user_id"],
    checksum_indexes: indexes,
    checksum_constant: constant,
  };
  validateRulesShape(rules);
  rules.verified_samples = verifyRules(source, rules);
  rules.rulegen_version = String(JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version);
  return rules;
}
