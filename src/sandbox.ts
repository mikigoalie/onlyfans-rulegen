import vm from "vm";

/**
 * Loads the OnlyFans signing chunk in a `vm` context and wires its sign
 * function to dependencies we control.
 *
 * `vm` is NOT a security boundary — the script can reach the host `process`.
 * It only keeps the script's globals apart from ours; CI runs this in a job
 * without write access or secrets (see .github/workflows/update.yml).
 *
 * Nothing here depends on webpack's interop helpers or on export names: the
 * stub `require` returns a recursive, callable Proxy, and the sign function is
 * recognised by what it returns.
 */

/** Hard limit for any single piece of untrusted code we run. */
export const TIMEOUT_MS = 5000;

/** `prefix:sha1:checksum:suffix` as produced with a real (hex) hash. */
export const SIGN_RE = /^\d+:[0-9a-f]{40}:[0-9a-f]+:[0-9a-f]+$/;

type ModuleFactory = (module: any, exports: any, require: any) => void;

export interface LoadedScript {
  modules: { id: string; factory: ModuleFactory }[];
  context: vm.Context;
  /** `SENTRY_RELEASE.id` baked into the chunk, if any. */
  revision: string | undefined;
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
 * Runs the whole script in a fresh vm context and captures every webpack
 * module it pushes.
 */
export function loadScript(source: string): LoadedScript {
  const sandbox: any = {
    window: { navigator: { userAgent: "onlyfans-rulegen" } },
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  const modules: LoadedScript["modules"] = [];
  sandbox.webpackChunkof_vue = {
    push: (chunk: any) => {
      const map = (chunk && chunk[1]) || {};
      for (const id of Object.keys(map)) {
        if (typeof map[id] === "function") modules.push({ id, factory: map[id] });
      }
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "of-sign.js", timeout: TIMEOUT_MS });

  if (modules.length === 0) {
    throw new Error("No webpack modules were found in the script");
  }
  const release = sandbox.window && sandbox.window.SENTRY_RELEASE;
  const revision =
    release && typeof release.id === "string" ? release.id : undefined;
  return { modules, context, revision };
}

/**
 * Calls `fn` from inside the context so `timeout` applies to the untrusted
 * code it runs.
 */
function guarded<T>(context: vm.Context, fn: () => T): T {
  const key = "__rulegen_guarded_call";
  context[key] = fn;
  try {
    return vm.runInContext(`${key}()`, context, { timeout: TIMEOUT_MS });
  } finally {
    delete context[key];
  }
}

/**
 * lodash-style `get(object, path, default)`. `path` may be an array of keys,
 * a key that exists as-is, or a dot/bracket path like `a.b[0].c`.
 */
export function lodashGet(obj: any, path: any, def?: any): any {
  if (obj == null) return def;
  let keys: PropertyKey[];
  if (Array.isArray(path)) {
    keys = path;
  } else if (typeof path === "symbol" || typeof path === "number") {
    keys = [path];
  } else {
    const str = String(path);
    keys =
      typeof obj === "object" && str in obj
        ? [str]
        : str.match(/[^.[\]]+/g) || [];
  }
  let cur: any = obj;
  for (const key of keys) {
    if (cur == null) return def;
    cur = cur[key];
  }
  return cur === undefined ? def : cur;
}

/**
 * A callable Proxy that returns itself for any property it doesn't know, so
 * any chain like `x.A.default.foo(...)` resolves to it.
 */
function recursiveProxy(
  apply: (...args: any[]) => any,
  known: (self: any) => Record<PropertyKey, any>
): any {
  const target = function () {};
  let table: Record<PropertyKey, any> = {};
  const self: any = new Proxy(target, {
    apply: (_t, _this, args) => apply(...args),
    construct: () => self,
    get: (_t, prop) => {
      if (Object.prototype.hasOwnProperty.call(table, prop)) return table[prop];
      // Symbols (toPrimitive, iterator...) and `then` must stay undefined, or
      // the proxy turns into an endless iterable / a thenable.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return self;
    },
  });
  table = known(self);
  return self;
}

/**
 * Builds the `require` handed to the module factory. Every module it returns
 * is the same recursive proxy, which acts as:
 *   - the SHA-1 hasher when called with one string,
 *   - lodash `get` otherwise,
 *   - the Vuex store (`.getters["auth/authUserId"]`) when walked into.
 * Webpack's interop helpers `.n`, `.d`, `.r`, `.o` are provided on both.
 */
function makeRequire(deps: SignerDeps, onHash: (input: string) => void): any {
  const getters = {
    get "auth/authUserId"() {
      return deps.userId();
    },
  };

  const helpers = (mod: () => any) => ({
    n: (m: any) => {
      const getter: any = () => (m && m.__esModule ? m.default : m);
      getter.a = getter;
      return getter;
    },
    d: (exports: any, defs: Record<string, () => any>) => {
      for (const key of Object.keys(defs)) {
        if (!Object.prototype.hasOwnProperty.call(exports, key)) {
          Object.defineProperty(exports, key, { enumerable: true, get: defs[key] });
        }
      }
    },
    r: (exports: any) => {
      Object.defineProperty(exports, "__esModule", { value: true });
    },
    o: (obj: any, prop: PropertyKey) =>
      Object.prototype.hasOwnProperty.call(obj, prop),
    default: mod(),
  });

  const dependency = recursiveProxy(
    (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === "string") {
        onHash(args[0]);
        return deps.hash(args[0]);
      }
      return lodashGet(args[0], args[1], args[2]);
    },
    (self) => ({ ...helpers(() => self), __esModule: true, getters })
  );

  return recursiveProxy(
    () => dependency,
    () => helpers(() => dependency)
  );
}

interface Candidate {
  moduleId: string;
  exportName: string;
  signer: Signer;
  first: SignCall;
}

/** Finds the string in a sign function's return value that looks like a sign. */
function signKey(result: any): string | null | undefined {
  if (typeof result === "string") return SIGN_RE.test(result) ? null : undefined;
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.sign === "string" && SIGN_RE.test(result.sign)) return "sign";
  return Object.keys(result).find(
    (k) => typeof result[k] === "string" && SIGN_RE.test(result[k])
  );
}

function candidatesIn(
  loaded: LoadedScript,
  moduleId: string,
  factory: ModuleFactory,
  deps: SignerDeps
): Candidate[] {
  let hashInputs: string[] = [];
  const req = makeRequire(deps, (input) => hashInputs.push(input));
  const mod: any = { exports: {} };
  try {
    guarded(loaded.context, () => factory.call(mod.exports, mod, mod.exports, req));
  } catch {
    return [];
  }

  const exported = mod.exports;
  const fns: [string, (...a: any[]) => any][] = [];
  if (typeof exported === "function") fns.push(["(module.exports)", exported]);
  if (exported && (typeof exported === "object" || typeof exported === "function")) {
    for (const name of Object.getOwnPropertyNames(exported)) {
      let value: unknown;
      try {
        value = exported[name];
      } catch {
        continue;
      }
      if (typeof value === "function") fns.push([name, value as any]);
    }
  }

  const found: Candidate[] = [];
  for (const [exportName, fn] of fns) {
    const call = (path: string) => {
      hashInputs = [];
      const result = guarded(loaded.context, () => fn({ url: path }));
      return { result, hashInputs };
    };
    let first: ReturnType<typeof call>;
    try {
      first = call("/api2/v2/init");
    } catch {
      continue;
    }
    const key = signKey(first.result);
    if (key === undefined) continue;

    const signer: Signer = (path) => {
      const { result, hashInputs } = call(path);
      const sign = key === null ? result : result && result[key];
      if (typeof sign !== "string") {
        throw new Error(`Sign function returned no sign string for ${JSON.stringify(path)}`);
      }
      return { sign, time: result && result.time, hashInputs };
    };
    found.push({
      moduleId,
      exportName,
      signer,
      first: {
        sign: key === null ? first.result : first.result[key],
        time: first.result && first.result.time,
        hashInputs: first.hashInputs,
      },
    });
  }
  return found;
}

/**
 * Finds the one sign function in the script and wires it to `deps`.
 *
 * `deps.hash` must return a 40-character hex string for the first call, so
 * the result can be recognised. Throws unless exactly one sign function is
 * found (or several that produce identical output).
 */
export function findSigner(loaded: LoadedScript, deps: SignerDeps): Signer {
  const found: Candidate[] = [];
  for (const { id, factory } of loaded.modules) {
    found.push(...candidatesIn(loaded, id, factory, deps));
  }

  if (found.length === 0) {
    throw new Error(
      "No sign function found: no exported function returned a " +
        "\"<prefix>:<sha1>:<checksum>:<suffix>\" string"
    );
  }

  const describe = (c: Candidate) => `module ${c.moduleId} export ${c.exportName}`;
  const fingerprint = (c: Candidate) => {
    const [prefix, , , suffix] = c.first.sign.split(":");
    const staticParam = (c.first.hashInputs[0] || "").split("\n")[0];
    return JSON.stringify([prefix, suffix, staticParam]);
  };
  for (const other of found.slice(1)) {
    if (fingerprint(other) !== fingerprint(found[0])) {
      throw new Error(
        `Found ${found.length} sign functions that disagree: ` +
          found.map(describe).join(", ")
      );
    }
  }
  return found[0].signer;
}
