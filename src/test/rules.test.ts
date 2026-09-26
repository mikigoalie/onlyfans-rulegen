import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { getRules } from "../rules";
import { verifyRules } from "../verify";
import { DynamicRules, validateRulesShape } from "../shape";
import { lodashGet } from "../sandbox";

const ROOT = join(__dirname, "..", "..");
const DIR = join(ROOT, "samples", "obfuscated");
const TOKEN = "33d57ade8c02dbc5a333db99ff9ae26a";
const SIGN = `sign:"1:${"a".repeat(40)}:1:abcdef01"`;
const samples = readdirSync(DIR).filter((f) => f.endsWith(".js")).sort();
const committed: DynamicRules = JSON.parse(readFileSync(join(ROOT, "dynamic-rules.json"), "utf8"));
const load = (f: string) => readFileSync(join(DIR, f), "utf8");
const cache = new Map<string, DynamicRules>();
const rulesFor = (f: string) => cache.get(f) ?? cache.set(f, getRules(load(f), TOKEN, basename(f, ".js"))).get(f)!;
const latest = samples[samples.length - 1];
const rev = basename(latest, ".js");

test("there are samples to test against", () => assert.ok(samples.length, `no samples in ${DIR}`));

for (const f of samples) {
  test(`extracts and verifies ${f}`, () => {
    const r = rulesFor(f);
    validateRulesShape(r);
    assert.equal(r.revision, basename(f, ".js"));
    assert.equal(r.verified_samples, 500);
  });
  if (basename(f, ".js") === committed.revision)
    test(`${f} reproduces the committed dynamic-rules.json`, () => {
      for (const k of Object.keys(committed) as (keyof DynamicRules)[])
        if (k !== "rulegen_version" && k !== "app_token") assert.deepEqual(rulesFor(f)[k], committed[k], k);
    });
}

test("a non-linear checksum is rejected", () => {
  const src = load(latest);
  const at = src.lastIndexOf("](0)", src.lastIndexOf("](16)"));
  assert.ok(at > 0, "could not find a checksum term to mutate");
  assert.throws(() => getRules(src.slice(0, at) + "](0)**2" + src.slice(at + 4), TOKEN, rev), /not linear|not additive/);
});

test("a sample whose sign export is renamed still extracts the same rules", () => {
  const src = load(latest);
  assert.ok(src.includes("n.A=W=>"), "could not find the sign export");
  const { rulegen_version: _a, ...actual } = getRules(src.replace("n.A=W=>", "n.Zq=W=>"), TOKEN, rev);
  const { rulegen_version: _b, ...expected } = rulesFor(latest);
  assert.deepEqual(actual, expected);
});

test("a sample exported through webpack's .d helper still extracts", () => {
  const src = load(latest);
  const out = src.replace(/,n\.A=(W=>)/, ",t.d(n,{B:()=>__sign});var __sign=$1");
  assert.notEqual(out, src, "could not rewrite the export");
  assert.equal(getRules(out, TOKEN, "x").static_param, rulesFor(latest).static_param);
});

test("a sample with no sign function is rejected", () => {
  const src = load(latest);
  const out = src.replace("n.A=W=>", "n.A=()=>({time:1}),W=>");
  assert.notEqual(out, src);
  assert.throws(() => getRules(out, TOKEN, rev), /No sign function found/);
});

test("two sign functions that disagree are rejected", () => {
  const other = `;self.webpackChunkof_vue.push([[1],{1:function(m,e){e.A=()=>({time:1,${SIGN}})}}]);`;
  assert.throws(() => getRules(load(latest) + other, TOKEN, rev), /sign functions that disagree/);
});

test("a script that never finishes loading times out", () => {
  assert.throws(() => getRules("for(;;){}", TOKEN, "x"), /timed out/);
});

test("a sign function that never returns times out", () => {
  const src = `self.webpackChunkof_vue.push([[1],{1:function(m,e){e.A=W=>{if(W.url!=="/api2/v2/init")for(;;){}return{time:1,${SIGN}}}}}]);`;
  assert.throws(() => getRules(src, TOKEN, "x"), /timed out/);
});

test("lodashGet handles dot, bracket and array paths", () => {
  const o = { a: { b: [{ c: 1 }] }, "x.y": 2, getters: { "auth/authUserId": 3 } };
  assert.equal(lodashGet(o, "a.b[0].c"), 1);
  assert.equal(lodashGet(o, ["a", "b", 0, "c"]), 1);
  assert.equal(lodashGet(o, "x.y"), 2);
  assert.equal(lodashGet(o, "getters.auth/authUserId"), 3);
  assert.equal(lodashGet(o, ["getters", "auth/authUserId"]), 3);
  assert.equal(lodashGet(o, "a.nope.c", "def"), "def");
  assert.equal(lodashGet(null, "a", "def"), "def");
});

test("rules with one index altered fail verification", () => {
  const idx = [...rulesFor(latest).checksum_indexes];
  const i = idx.findIndex((v) => !idx.includes((v + 1) % 40));
  idx[i] = (idx[i] + 1) % 40;
  assert.throws(() => verifyRules(load(latest), { ...rulesFor(latest), checksum_indexes: idx.sort((a, b) => a - b) }), /checksum/);
});

test("rules with a different constant fail verification", () => {
  const r = rulesFor(latest);
  assert.throws(() => verifyRules(load(latest), { ...r, checksum_constant: r.checksum_constant + 1 }), /checksum/);
});

test("rules with a different static_param fail verification", () => {
  const r = rulesFor(latest);
  assert.throws(() => verifyRules(load(latest), { ...r, static_param: "x" + r.static_param }), /hashed message/);
});

test("the shape check rejects malformed rules", () => {
  const good = rulesFor(latest);
  validateRulesShape(good);
  for (const patch of [
    { prefix: "abc" }, { suffix: "123" }, { static_param: "" }, { checksum_indexes: [] }, { checksum_indexes: [3, 2] },
    { checksum_indexes: [0, 40] }, { checksum_constant: 1.5 }, { revision: "20260925-abc" }, { app_token: "nope" },
  ])
    assert.throws(() => validateRulesShape({ ...good, ...patch }), /Invalid dynamic rules/, JSON.stringify(patch));
});
