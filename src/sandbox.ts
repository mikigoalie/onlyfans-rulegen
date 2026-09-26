import vm from "vm";

export const TIMEOUT_MS = 5000;
export const SIGN_RE = /^\d+:[0-9a-f]{40}:[0-9a-f]+:[0-9a-f]+$/;

type Factory = (module: any, exports: any, require: any) => void;
export interface LoadedScript { modules: { id: string; factory: Factory }[]; context: vm.Context; revision?: string }
export interface SignerDeps { hash: (input: string) => string; userId: () => number | string }
export interface SignCall { sign: string; time: unknown; hashInputs: string[] }
export type Signer = (path: string) => SignCall;

const has = (o: any, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

export function loadScript(source: string): LoadedScript {
  const modules: LoadedScript["modules"] = [];
  const sandbox: any = { window: { navigator: { userAgent: "onlyfans-rulegen" } } };
  sandbox.self = sandbox.global = sandbox.globalThis = sandbox;
  sandbox.webpackChunkof_vue = {
    push: (chunk: any) => Object.entries((chunk && chunk[1]) || {}).forEach(([id, f]) => typeof f === "function" && modules.push({ id, factory: f as Factory })),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "of-sign.js", timeout: TIMEOUT_MS });
  if (!modules.length) throw new Error("No webpack modules were found in the script");
  const id = sandbox.window?.SENTRY_RELEASE?.id;
  return { modules, context, revision: typeof id === "string" ? id : undefined };
}

function guarded<T>(context: vm.Context, fn: () => T): T {
  context.__rulegen_guarded_call = fn;
  try {
    return vm.runInContext("__rulegen_guarded_call()", context, { timeout: TIMEOUT_MS });
  } finally {
    delete context.__rulegen_guarded_call;
  }
}

export function lodashGet(obj: any, path: any, def?: any): any {
  if (obj == null) return def;
  const keys: PropertyKey[] = Array.isArray(path) ? path
    : typeof path === "symbol" || typeof path === "number" ? [path]
    : typeof obj === "object" && String(path) in obj ? [String(path)]
    : String(path).match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return def;
    cur = cur[k];
  }
  return cur === undefined ? def : cur;
}

function recursiveProxy(apply: (...a: any[]) => any, known: (self: any) => Record<PropertyKey, any>): any {
  let table: Record<PropertyKey, any> = {};
  const self: any = new Proxy(function () {}, {
    apply: (_t, _this, args) => apply(...args),
    construct: () => self,
    get: (_t, p) => (has(table, p) ? table[p] : typeof p === "symbol" || p === "then" ? undefined : self),
  });
  table = known(self);
  return self;
}

function makeRequire(deps: SignerDeps, onHash: (input: string) => void): any {
  const getters = { get "auth/authUserId"() { return deps.userId(); } };
  const helpers = (def: any) => ({
    n: (m: any) => { const g: any = () => (m && m.__esModule ? m.default : m); g.a = g; return g; },
    d: (e: any, defs: Record<string, () => any>) => Object.keys(defs).forEach((k) => has(e, k) || Object.defineProperty(e, k, { enumerable: true, get: defs[k] })),
    r: (e: any) => Object.defineProperty(e, "__esModule", { value: true }),
    o: has,
    default: def,
  });
  const dep = recursiveProxy(
    (...a) => (a.length === 1 && typeof a[0] === "string" ? (onHash(a[0]), deps.hash(a[0])) : lodashGet(a[0], a[1], a[2])),
    (self) => ({ ...helpers(self), __esModule: true, getters })
  );
  return recursiveProxy(() => dep, () => helpers(dep));
}

function signKey(r: any): string | null | undefined {
  if (typeof r === "string") return SIGN_RE.test(r) ? null : undefined;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.sign === "string" && SIGN_RE.test(r.sign)) return "sign";
  return Object.keys(r).find((k) => typeof r[k] === "string" && SIGN_RE.test(r[k]));
}

interface Candidate { name: string; signer: Signer; first: SignCall }

function candidatesIn(loaded: LoadedScript, id: string, factory: Factory, deps: SignerDeps): Candidate[] {
  let hashInputs: string[] = [];
  const req = makeRequire(deps, (i) => hashInputs.push(i));
  const mod: any = { exports: {} };
  try {
    guarded(loaded.context, () => factory.call(mod.exports, mod, mod.exports, req));
  } catch {
    return [];
  }
  const ex = mod.exports;
  const fns: [string, any][] = typeof ex === "function" ? [["(module.exports)", ex]] : [];
  if (ex && (typeof ex === "object" || typeof ex === "function"))
    for (const name of Object.getOwnPropertyNames(ex)) {
      try {
        if (typeof ex[name] === "function") fns.push([name, ex[name]]);
      } catch {}
    }

  const found: Candidate[] = [];
  for (const [name, fn] of fns) {
    const call = (path: string) => {
      hashInputs = [];
      return { result: guarded(loaded.context, () => fn({ url: path })), hashInputs };
    };
    let first;
    try {
      first = call("/api2/v2/init");
    } catch {
      continue;
    }
    const key = signKey(first.result);
    if (key === undefined) continue;
    const pick = ({ result, hashInputs }: ReturnType<typeof call>): SignCall =>
      ({ sign: key === null ? result : result?.[key], time: result?.time, hashInputs });
    const signer: Signer = (path) => {
      const c = pick(call(path));
      if (typeof c.sign !== "string") throw new Error(`Sign function returned no sign string for ${JSON.stringify(path)}`);
      return c;
    };
    found.push({ name: `module ${id} export ${name}`, signer, first: pick(first) });
  }
  return found;
}

export function findSigner(loaded: LoadedScript, deps: SignerDeps): Signer {
  const found = loaded.modules.flatMap(({ id, factory }) => candidatesIn(loaded, id, factory, deps));
  if (!found.length)
    throw new Error('No sign function found: no exported function returned a "<prefix>:<sha1>:<checksum>:<suffix>" string');
  const fp = ({ first }: Candidate) => {
    const [prefix, , , suffix] = first.sign.split(":");
    return JSON.stringify([prefix, suffix, (first.hashInputs[0] || "").split("\n")[0]]);
  };
  if (found.some((c) => fp(c) !== fp(found[0])))
    throw new Error(`Found ${found.length} sign functions that disagree: ${found.map((c) => c.name).join(", ")}`);
  return found[0].signer;
}
