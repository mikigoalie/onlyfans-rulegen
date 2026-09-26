import { readFileSync } from "fs";
import { join } from "path";
import { DynamicRules, HASH_LEN, validateRulesShape } from "./shape";
import { findSigner, loadScript, SignCall, Signer } from "./sandbox";
import { verifyRules } from "./verify";

export { DynamicRules } from "./shape";

/**
 * Extracts OnlyFans dynamic signing rules by *executing* the obfuscated
 * signing module in a sandbox and reading the rules straight out of the real
 * `sign` function — instead of statically deobfuscating it.
 *
 * The webpack chunk exports a function (currently `n.A(payload)`) that returns
 * an object whose `sign` field is `"<prefix>:<sha1>:<checksum hex>:<suffix>"`,
 * where the checksum is `Math.abs(sum(hash[i].charCodeAt(0) for each index i)
 * + C)`. The function is found by that behaviour, not by its name.
 *
 * We stub the module's dependencies (the SHA-1 hasher and lodash `get`) so we
 * fully control the hash string, then probe the checksum function one hash
 * position at a time to recover the index multiset and the constant `C`. The
 * static param is captured from the hasher input, and prefix/suffix straight
 * from the produced sign string.
 *
 * Every assumption the probe makes (linearity, additivity, the hash being
 * consumed as-is) is checked while probing, and the resulting rules are then
 * verified against the real module running with real SHA-1 (see verify.ts).
 */

/**
 * Recovers the checksum index multiset and the additive constant by probing.
 *
 * The checksum is `abs(sum_j c_j * hash[j].charCodeAt(0) + C)`, where `c_j` is
 * how many times hash position `j` is referenced. We pick a base char code high
 * enough that the inner sum is always positive (so `abs` is the identity), then
 * bump one position's char code by 1 at a time: the delta equals `c_j`.
 *
 * That only holds if the checksum really has that shape, so every assumption
 * is tested along the way and any violation throws.
 */
function probeChecksum(signer: Signer, forceHash: (h: string) => void): {
  indexes: number[];
  constant: number;
} {
  const BASE = 500; // 500 * 40 dwarfs any plausible constant -> sum stays > 0

  const checksumFor = (codes: number[], path = "/api2/v2/probe"): number => {
    const hash = String.fromCharCode(...codes);
    forceHash(hash);
    let call: SignCall;
    try {
      call = signer(path);
    } catch (err) {
      throw new Error(
        `Sign function failed on a ${HASH_LEN}-character hash (does it read ` +
          `past position ${HASH_LEN - 1} or expect a different hash?): ` +
          (err as Error).message
      );
    }
    if (call.hashInputs.length !== 1) {
      throw new Error(
        `Expected the module to hash exactly once per sign, saw ${call.hashInputs.length}`
      );
    }
    return parseInt(parseSign(call.sign, hash).checksum, 16);
  };

  const with_ = (changes: Record<number, number>): number[] => {
    const codes = new Array(HASH_LEN).fill(BASE);
    for (const [j, code] of Object.entries(changes)) codes[Number(j)] = code;
    return codes;
  };

  const cBase = checksumFor(with_({}));
  if (checksumFor(with_({}), "/api2/v2/other?x=1") !== cBase) {
    throw new Error(
      "Checksum changed with the path while the hash stayed fixed; it is " +
        "not a function of the hash alone"
    );
  }

  const deltas: number[] = [];
  for (let j = 0; j < HASH_LEN; j++) {
    const d1 = checksumFor(with_({ [j]: BASE + 1 })) - cBase;
    if (!Number.isInteger(d1) || d1 < 0) {
      throw new Error(`Checksum delta at position ${j} is ${d1}, expected a non-negative integer`);
    }
    const d2 = checksumFor(with_({ [j]: BASE + 2 })) - cBase;
    if (d2 !== 2 * d1) {
      throw new Error(
        `Checksum is not linear at position ${j}: +1 gave ${d1}, +2 gave ${d2}`
      );
    }
    deltas.push(d1);
  }

  for (let j = 0; j < HASH_LEN; j++) {
    for (let k = j + 1; k < HASH_LEN; k++) {
      const d = checksumFor(with_({ [j]: BASE + 1, [k]: BASE + 1 })) - cBase;
      if (d !== deltas[j] + deltas[k]) {
        throw new Error(
          `Checksum is not additive at positions ${j},${k}: ` +
            `expected ${deltas[j] + deltas[k]}, got ${d}`
        );
      }
    }
  }

  const total = deltas.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error("Checksum does not depend on the hash");
  const constant = cBase - BASE * total;

  // The affine model must also predict a hash far from the probe point.
  const far = 700;
  const cFar = checksumFor(new Array(HASH_LEN).fill(far));
  if (cFar !== far * total + constant) {
    throw new Error(
      `Checksum model does not extrapolate: predicted ${far * total + constant}, got ${cFar}`
    );
  }

  const indexes: number[] = [];
  for (let j = 0; j < HASH_LEN; j++) {
    for (let k = 0; k < deltas[j]; k++) indexes.push(j);
  }

  return { indexes, constant };
}

/**
 * Splits `prefix:hash:checksum:suffix` around the hash we know the module was
 * given. Throws if the sign does not carry that exact hash.
 */
function parseSign(
  sign: string,
  hash: string
): { prefix: string; checksum: string; suffix: string } {
  const at = sign.indexOf(`:${hash}:`);
  const prefix = sign.slice(0, at);
  const [checksum, suffix, ...rest] = sign.slice(at + hash.length + 2).split(":");
  if (at < 0 || rest.length > 0 || suffix === undefined) {
    throw new Error(
      "Sign string does not carry the hash the module was given; the " +
        `checksum may be computed over something other than the SHA-1: ${sign}`
    );
  }
  if (!/^[0-9a-f]+$/.test(checksum)) {
    throw new Error(`Checksum ${JSON.stringify(checksum)} is not hex`);
  }
  return { prefix, checksum, suffix };
}

function rulegenVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8")
  );
  return String(pkg.version);
}

/**
 * Extracts the full dynamic signing rules from an obfuscated script source,
 * and verifies them against the real module before returning.
 *
 * @param source           raw JS of the OnlyFans signing webpack chunk
 * @param appToken         the app token (from app.js)
 * @param fallbackRevision used if the script has no `SENTRY_RELEASE` id
 */
export function getRules(
  source: string,
  appToken: string,
  fallbackRevision: string
): DynamicRules {
  const loaded = loadScript(source);

  let forced = "a".repeat(HASH_LEN);
  const signer = findSigner(loaded, {
    hash: () => forced,
    userId: () => 0,
  });
  const forceHash = (h: string) => {
    forced = h;
  };

  forceHash("a".repeat(HASH_LEN));
  const probe = signer("/api2/v2/probe");
  const { prefix, suffix } = parseSign(probe.sign, forced);
  const input = probe.hashInputs[0];
  const staticParam = input === undefined ? "" : input.split("\n")[0];
  if (!staticParam) {
    throw new Error("Failed to capture static_param");
  }

  const { indexes, constant } = probeChecksum(signer, forceHash);

  const revision = loaded.revision || fallbackRevision;

  const rules: DynamicRules = {
    end: suffix,
    start: prefix,
    format: `${prefix}:{}:{:x}:${suffix}`,
    prefix,
    suffix,
    revision,
    app_token: appToken,
    static_param: staticParam,
    remove_headers: ["user_id"],
    checksum_indexes: indexes,
    checksum_constant: constant,
  };

  validateRulesShape(rules);
  rules.verified_samples = verifyRules(source, rules);
  rules.rulegen_version = rulegenVersion();
  return rules;
}
