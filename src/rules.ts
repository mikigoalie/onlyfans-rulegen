import vm from "vm";
import { readFileSync } from "fs";
import { join } from "path";
import { DynamicRules, HASH_LEN, validateRulesShape } from "./shape";
import { verifyRules } from "./verify";

export { DynamicRules } from "./shape";

/**
 * Extracts OnlyFans dynamic signing rules by *executing* the obfuscated
 * signing module in a sandbox and reading the rules straight out of the real
 * `sign` function — instead of statically deobfuscating it.
 *
 * The webpack chunk exports a function `n.A(payload)` that returns an object
 * whose `sign` field is `"<prefix>:<sha1>:<checksum hex>:<suffix>"`, where the
 * checksum is `Math.abs(sum(hash[i].charCodeAt(0) for each index i) + C)`.
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

type SignModule = (module: any, exports: any, require: any) => void;

export interface LoadedScript {
  modules: SignModule[];
  sandbox: any;
}

/** The dependencies we swap into the sign module. */
export interface SignerDeps {
  /** Stands in for the SHA-1 hasher: gets the message, returns the digest. */
  hash: (input: string) => string;
  /** The user id the stubbed Vuex store reports. */
  userId: () => number | string;
}

export interface SignCall {
  /** The `prefix:hash:checksum:suffix` string. */
  sign: string;
  /** The `time` field the module returned. */
  time: unknown;
  /** Every string the module passed to the hasher during this call. */
  hashInputs: string[];
}

export type Signer = (path: string) => SignCall;

/**
 * Runs the whole script in a vm context and captures every webpack module it
 * pushes, plus the sandbox (for reading `SENTRY_RELEASE`).
 */
export function loadScript(source: string): LoadedScript {
  const sandbox: any = {
    window: { navigator: { userAgent: "onlyfans-rulegen" } },
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  const modules: SignModule[] = [];
  sandbox.self.webpackChunkof_vue = {
    push: (chunk: any) => {
      const map = (chunk && chunk[1]) || {};
      for (const id of Object.keys(map)) {
        if (typeof map[id] === "function") modules.push(map[id]);
      }
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "of-sign.js" });

  if (modules.length === 0) {
    throw new Error("No webpack modules were found in the script");
  }
  return { modules, sandbox };
}

/** lodash-style `get(object, "a.b.c", default)`. */
export function lodashGet(obj: any, path: any, def?: any): any {
  if (obj == null) return def;
  let cur: any = obj;
  for (const key of String(path).split(".")) {
    if (cur == null) return def;
    cur = cur[key];
  }
  return cur === undefined ? def : cur;
}

/**
 * Instantiates one module with stubbed dependencies and returns a function
 * that calls its exported sign function for a given path.
 */
export function createSigner(moduleFn: SignModule, deps: SignerDeps): Signer {
  let hashInputs: string[] = [];

  // A single stub that serves as both the SHA-1 hasher and lodash `get`,
  // distinguished by call shape:
  //   - hash(message)            -> exactly one string arg
  //   - get(object, path, def)   -> object first arg
  const stub = (...args: any[]): any => {
    if (args.length === 1 && typeof args[0] === "string") {
      hashInputs.push(args[0]);
      return deps.hash(args[0]);
    }
    return lodashGet(args[0], args[1], args[2]);
  };

  const store = {
    getters: {
      get "auth/authUserId"() {
        return deps.userId();
      },
    },
  };

  const req: any = () => ({ A: store });
  req.n = () => () => stub;

  const mod: any = { exports: {} };
  moduleFn(mod, mod.exports, req);

  const exported = mod.exports;
  if (!exported || typeof exported.A !== "function") {
    throw new Error("Module does not export a sign function");
  }

  return (path: string): SignCall => {
    hashInputs = [];
    const result = exported.A({ url: path });
    const sign = findSign(result);
    if (!sign) throw new Error("Sign function did not produce a sign string");
    return { sign, time: result.time, hashInputs };
  };
}

/** Pulls the `prefix:hash:checksum:suffix` string out of the returned object. */
function findSign(result: any): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.sign === "string" && result.sign.split(":").length === 4) {
    return result.sign;
  }
  return Object.values(result).find(
    (v): v is string => typeof v === "string" && v.split(":").length === 4
  );
}

/** Finds the one module in the script that signs, and wires it to `deps`. */
export function findSigner(loaded: LoadedScript, deps: SignerDeps): Signer {
  for (const fn of loaded.modules) {
    try {
      const signer = createSigner(fn, deps);
      signer("/api2/v2/init");
      return signer;
    } catch {
      // not the sign module, keep looking
    }
  }
  throw new Error("Could not find a signing module in the script");
}

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
    const parts = call.sign.split(":");
    if (parts.length !== 4 || parts[1] !== hash) {
      throw new Error(
        "Sign string does not carry the hash the module was given; the " +
          "checksum may be computed over something other than the SHA-1"
      );
    }
    if (!/^[0-9a-f]+$/.test(parts[2])) {
      throw new Error(`Checksum ${JSON.stringify(parts[2])} is not hex`);
    }
    return parseInt(parts[2], 16);
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
  const parts = probe.sign.split(":");
  if (parts.length !== 4) {
    throw new Error(`Unexpected sign format: ${probe.sign}`);
  }
  const prefix = parts[0];
  const suffix = parts[parts.length - 1];
  const input = probe.hashInputs[0];
  const staticParam = input === undefined ? "" : input.split("\n")[0];
  if (!staticParam) {
    throw new Error("Failed to capture static_param");
  }

  const { indexes, constant } = probeChecksum(signer, forceHash);

  const sandbox = loaded.sandbox;
  const revision: string =
    (sandbox &&
      sandbox.window &&
      sandbox.window.SENTRY_RELEASE &&
      sandbox.window.SENTRY_RELEASE.id) ||
    fallbackRevision;

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
