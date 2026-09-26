/**
 * Pure shape checks for dynamic-rules.json.
 *
 * This file must never import `vm` or anything that runs the OnlyFans code:
 * the publish job uses it (via validate.ts) to re-check an artifact produced
 * by the untrusted extract job.
 */

// OnlyFans signs over a SHA-1 hex digest, so the hash the checksum indexes
// into is always 40 characters long.
export const HASH_LEN = 40;

export const REVISION_RE = /^\d{12}-[a-f0-9]{10}$/;

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
  // Additive keys. Consumers that don't know them can ignore them.
  verified_samples?: number;
  rulegen_version?: string;
}

/**
 * Throws if `value` is not a well-formed rules object. Returns it typed.
 */
export function validateRulesShape(value: unknown): DynamicRules {
  const fail = (msg: string): never => {
    throw new Error(`Invalid dynamic rules: ${msg}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("not an object");
  }
  const r = value as Record<string, unknown>;

  for (const key of [
    "end",
    "start",
    "format",
    "prefix",
    "suffix",
    "revision",
    "app_token",
    "static_param",
  ]) {
    if (typeof r[key] !== "string") fail(`${key} must be a string`);
  }

  const prefix = r.prefix as string;
  const suffix = r.suffix as string;
  if (!/^\d+$/.test(prefix)) fail(`prefix ${JSON.stringify(prefix)} is not numeric`);
  if (!/^[0-9a-f]{8}$/.test(suffix)) {
    fail(`suffix ${JSON.stringify(suffix)} is not 8 hex characters`);
  }
  if (r.start !== prefix) fail("start must equal prefix");
  if (r.end !== suffix) fail("end must equal suffix");
  if (r.format !== `${prefix}:{}:{:x}:${suffix}`) {
    fail(`format ${JSON.stringify(r.format)} does not match prefix/suffix`);
  }
  if (!REVISION_RE.test(r.revision as string)) {
    fail(`revision ${JSON.stringify(r.revision)} does not match ${REVISION_RE}`);
  }
  if (!/^[0-9a-f]{32}$/.test(r.app_token as string)) {
    fail(`app_token ${JSON.stringify(r.app_token)} is not 32 hex characters`);
  }
  if ((r.static_param as string).length === 0) fail("static_param is empty");

  if (
    !Array.isArray(r.remove_headers) ||
    !r.remove_headers.every((h) => typeof h === "string")
  ) {
    fail("remove_headers must be an array of strings");
  }

  const idx = r.checksum_indexes;
  if (!Array.isArray(idx) || idx.length === 0) {
    fail("checksum_indexes must be a non-empty array");
  }
  (idx as unknown[]).forEach((v, i, a) => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= HASH_LEN) {
      fail(`checksum_indexes[${i}] = ${JSON.stringify(v)} is not an integer in 0-${HASH_LEN - 1}`);
    }
    if (i > 0 && (a[i - 1] as number) > (v as number)) {
      fail("checksum_indexes is not sorted");
    }
  });

  if (!Number.isInteger(r.checksum_constant)) {
    fail(`checksum_constant ${JSON.stringify(r.checksum_constant)} is not an integer`);
  }

  if (
    r.verified_samples !== undefined &&
    (!Number.isInteger(r.verified_samples) || (r.verified_samples as number) <= 0)
  ) {
    fail("verified_samples must be a positive integer");
  }
  if (r.rulegen_version !== undefined && typeof r.rulegen_version !== "string") {
    fail("rulegen_version must be a string");
  }

  return r as unknown as DynamicRules;
}

/** `abs(sum(hash.charCodeAt(i) for i in indexes) + constant)`, in hex. */
export function checksumHex(hash: string, rules: DynamicRules): string {
  let sum = 0;
  for (const i of rules.checksum_indexes) sum += hash.charCodeAt(i);
  return Math.abs(sum + rules.checksum_constant).toString(16);
}
