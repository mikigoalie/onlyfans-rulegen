import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { getRules } from "../rules";
import { verifyRules } from "../verify";
import { DynamicRules, validateRulesShape } from "../shape";

const ROOT = join(__dirname, "..", "..");
const SAMPLES_DIR = join(ROOT, "samples", "obfuscated");
const APP_TOKEN = "33d57ade8c02dbc5a333db99ff9ae26a";

const samples = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith(".js"))
  .sort();

const committed = JSON.parse(
  readFileSync(join(ROOT, "dynamic-rules.json"), "utf8")
) as DynamicRules;

function load(file: string): string {
  return readFileSync(join(SAMPLES_DIR, file), "utf8");
}

// Rules are extracted once per sample and reused by the tests below.
const extracted = new Map<string, DynamicRules>();
function rulesFor(file: string): DynamicRules {
  let rules = extracted.get(file);
  if (!rules) {
    rules = getRules(load(file), APP_TOKEN, basename(file, ".js"));
    extracted.set(file, rules);
  }
  return rules;
}

test("there are samples to test against", () => {
  assert.ok(samples.length > 0, `no samples in ${SAMPLES_DIR}`);
});

for (const file of samples) {
  test(`extracts and verifies ${file}`, () => {
    const rules = rulesFor(file);
    validateRulesShape(rules);
    assert.equal(rules.revision, basename(file, ".js"));
    assert.equal(rules.verified_samples, 500);
  });

  if (basename(file, ".js") === committed.revision) {
    test(`${file} reproduces the committed dynamic-rules.json`, () => {
      const rules = rulesFor(file);
      for (const key of Object.keys(committed) as (keyof DynamicRules)[]) {
        if (key === "rulegen_version" || key === "app_token") continue;
        assert.deepEqual(rules[key], committed[key], key);
      }
    });
  }
}

// --- negative tests: every one of these must make extraction/verification throw

const latest = samples[samples.length - 1];

test("a non-linear checksum is rejected", () => {
  const src = load(latest);
  // Square the last `hash[i].charCodeAt(0)` term before `.toString(16)`.
  const end = src.lastIndexOf("](16)");
  const at = src.lastIndexOf("](0)", end);
  assert.ok(at > 0, "could not find a checksum term to mutate");
  const mutated = src.slice(0, at) + "](0)**2" + src.slice(at + "](0)".length);
  assert.throws(
    () => getRules(mutated, APP_TOKEN, basename(latest, ".js")),
    /not linear|not additive/
  );
});

test("a sample whose sign export is renamed is rejected", () => {
  const src = load(latest);
  assert.ok(src.includes("n.A=W=>"), "could not find the sign export");
  const mutated = src.replace("n.A=W=>", "n.Z=W=>");
  assert.throws(() => getRules(mutated, APP_TOKEN, basename(latest, ".js")));
});

test("rules with one index altered fail verification", () => {
  const rules = rulesFor(latest);
  const indexes = [...rules.checksum_indexes];
  const i = indexes.findIndex((v) => !indexes.includes((v + 1) % 40));
  indexes[i] = (indexes[i] + 1) % 40;
  indexes.sort((a, b) => a - b);
  assert.throws(
    () => verifyRules(load(latest), { ...rules, checksum_indexes: indexes }),
    /checksum/
  );
});

test("rules with a different constant fail verification", () => {
  const rules = rulesFor(latest);
  assert.throws(
    () =>
      verifyRules(load(latest), {
        ...rules,
        checksum_constant: rules.checksum_constant + 1,
      }),
    /checksum/
  );
});

test("rules with a different static_param fail verification", () => {
  const rules = rulesFor(latest);
  assert.throws(
    () =>
      verifyRules(load(latest), { ...rules, static_param: "x" + rules.static_param }),
    /hashed message/
  );
});

test("the shape check rejects malformed rules", () => {
  const good = rulesFor(latest);
  const bad: Partial<Record<keyof DynamicRules, unknown>>[] = [
    { prefix: "abc" },
    { suffix: "123" },
    { static_param: "" },
    { checksum_indexes: [] },
    { checksum_indexes: [3, 2] },
    { checksum_indexes: [0, 40] },
    { checksum_constant: 1.5 },
    { revision: "20260925-abc" },
    { app_token: "nope" },
  ];
  validateRulesShape(good);
  for (const patch of bad) {
    assert.throws(() => validateRulesShape({ ...good, ...patch }), /Invalid dynamic rules/, JSON.stringify(patch));
  }
});
