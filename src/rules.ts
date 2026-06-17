import vm from "vm";

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
 * Running the browser-correct code as-is means the result is correct by
 * construction — no obfuscation handling required, and it self-heals when
 * OnlyFans rotates their obfuscation.
 */

// OnlyFans signs over a SHA-1 hex digest, so the hash the checksum indexes
// into is always 40 characters long.
const HASH_LEN = 40;

export interface DynamicRules {
  end: string;
  start: string;
  format: string;
  prefix: string;
  suffix: string;
  revision: string;
  app_token: string;
  static_param: string;
  remove_headers: string[];
  checksum_indexes: number[];
  checksum_constant: number;
}

type SignModule = (module: any, exports: any, require: any) => void;

interface LoadedScript {
  modules: SignModule[];
  sandbox: any;
}

/**
 * Runs the whole script in a vm context and captures every webpack module it
 * pushes, plus the sandbox (for reading `SENTRY_RELEASE`).
 */
function loadScript(source: string): LoadedScript {
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

interface SignResult {
  sign: string;
  staticParam: string | undefined;
}

/**
 * Instantiates one module with stubbed dependencies and calls its exported
 * sign function, forcing the hash to `hashValue` so the checksum is computed
 * over a string we control.
 */
function runSign(moduleFn: SignModule, hashValue: string): SignResult {
  let staticParam: string | undefined;

  // A single stub that serves as both the SHA-1 hasher and lodash `get`,
  // distinguished by call shape:
  //   - hash(message)            -> exactly one string arg
  //   - get(object, path, def)   -> object first arg
  const stub = (...args: any[]): any => {
    if (args.length === 1 && typeof args[0] === "string") {
      const input = args[0];
      const nl = input.indexOf("\n");
      staticParam = nl >= 0 ? input.slice(0, nl) : input;
      return hashValue;
    }
    const [obj, path, def] = args;
    if (obj == null) return def;
    let cur: any = obj;
    for (const key of String(path).split(".")) {
      if (cur == null) return def;
      cur = cur[key];
    }
    return cur === undefined ? def : cur;
  };

  const req: any = () => ({ A: {} });
  req.n = () => () => stub;

  const mod: any = { exports: {} };
  moduleFn(mod, mod.exports, req);

  const exported = mod.exports;
  if (!exported || typeof exported.A !== "function") {
    throw new Error("Module does not export a sign function");
  }

  const result = exported.A({ url: "/api/probe" });
  const sign = findSign(result);
  if (!sign) throw new Error("Sign function did not produce a sign string");

  return { sign, staticParam };
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

function checksumInt(moduleFn: SignModule, hashValue: string): number {
  const { sign } = runSign(moduleFn, hashValue);
  // sign = "<prefix>:<hash>:<checksum hex>:<suffix>"
  return parseInt(sign.split(":")[2], 16);
}

/**
 * Recovers the checksum index multiset and the additive constant by probing.
 *
 * The checksum is `abs(sum_j c_j * hash[j].charCodeAt(0) + C)`, where `c_j` is
 * how many times hash position `j` is referenced. We pick a base char code high
 * enough that the inner sum is always positive (so `abs` is the identity), then
 * bump one position's char code by 1 at a time: the delta equals `c_j`.
 */
function probeChecksum(moduleFn: SignModule): {
  indexes: number[];
  constant: number;
} {
  const baseCode = 500; // 500 * 40 dwarfs any plausible constant -> sum stays > 0
  const baseChar = String.fromCharCode(baseCode);
  const probeChar = String.fromCharCode(baseCode + 1);

  const base = baseChar.repeat(HASH_LEN);
  const cBase = checksumInt(moduleFn, base);

  const counts: number[] = [];
  for (let j = 0; j < HASH_LEN; j++) {
    const chars = base.split("");
    chars[j] = probeChar;
    counts[j] = checksumInt(moduleFn, chars.join("")) - cBase;
  }

  const total = counts.reduce((a, b) => a + b, 0);
  const constant = cBase - baseCode * total;

  const indexes: number[] = [];
  for (let j = 0; j < HASH_LEN; j++) {
    for (let k = 0; k < counts[j]; k++) indexes.push(j);
  }

  return { indexes, constant };
}

/**
 * Extracts the full dynamic signing rules from an obfuscated script source.
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
  const { modules, sandbox } = loadScript(source);

  // Find the module that actually produces a sign value.
  let moduleFn: SignModule | undefined;
  let probe: SignResult | undefined;
  for (const fn of modules) {
    try {
      const r = runSign(fn, "a".repeat(HASH_LEN));
      moduleFn = fn;
      probe = r;
      break;
    } catch {
      // not the sign module, keep looking
    }
  }
  if (!moduleFn || !probe) {
    throw new Error("Could not find a signing module in the script");
  }

  const parts = probe.sign.split(":");
  if (parts.length !== 4) {
    throw new Error(`Unexpected sign format: ${probe.sign}`);
  }
  const prefix = parts[0];
  const suffix = parts[parts.length - 1];
  const staticParam = probe.staticParam;
  if (!staticParam) {
    throw new Error("Failed to capture static_param");
  }

  const { indexes, constant } = probeChecksum(moduleFn);

  const revision: string =
    (sandbox &&
      sandbox.window &&
      sandbox.window.SENTRY_RELEASE &&
      sandbox.window.SENTRY_RELEASE.id) ||
    fallbackRevision;

  return {
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
}
