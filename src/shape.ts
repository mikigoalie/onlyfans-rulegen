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
  verified_samples?: number;
  rulegen_version?: string;
}

export function validateRulesShape(value: unknown): DynamicRules {
  const r = value as any;
  const need = (ok: unknown, msg: string) => {
    if (!ok) throw new Error(`Invalid dynamic rules: ${msg}`);
  };
  need(r && typeof r === "object" && !Array.isArray(r), "not an object");
  for (const k of ["end", "start", "format", "prefix", "suffix", "revision", "app_token", "static_param"])
    need(typeof r[k] === "string", `${k} must be a string`);
  const { prefix, suffix, checksum_indexes: idx } = r;
  need(/^\d+$/.test(prefix), `prefix ${JSON.stringify(prefix)} is not numeric`);
  need(/^[0-9a-f]{8}$/.test(suffix), `suffix ${JSON.stringify(suffix)} is not 8 hex characters`);
  need(r.start === prefix, "start must equal prefix");
  need(r.end === suffix, "end must equal suffix");
  need(r.format === `${prefix}:{}:{:x}:${suffix}`, `format ${JSON.stringify(r.format)} does not match prefix/suffix`);
  need(REVISION_RE.test(r.revision), `revision ${JSON.stringify(r.revision)} does not match ${REVISION_RE}`);
  need(/^[0-9a-f]{32}$/.test(r.app_token), `app_token ${JSON.stringify(r.app_token)} is not 32 hex characters`);
  need(r.static_param.length, "static_param is empty");
  need(Array.isArray(r.remove_headers) && r.remove_headers.every((h: unknown) => typeof h === "string"), "remove_headers must be an array of strings");
  need(Array.isArray(idx) && idx.length, "checksum_indexes must be a non-empty array");
  idx.forEach((v: any, i: number) => {
    need(Number.isInteger(v) && v >= 0 && v < HASH_LEN, `checksum_indexes[${i}] = ${JSON.stringify(v)} is not an integer in 0-${HASH_LEN - 1}`);
    need(!i || idx[i - 1] <= v, "checksum_indexes is not sorted");
  });
  need(Number.isInteger(r.checksum_constant), `checksum_constant ${JSON.stringify(r.checksum_constant)} is not an integer`);
  need(r.verified_samples === undefined || (Number.isInteger(r.verified_samples) && r.verified_samples > 0), "verified_samples must be a positive integer");
  need(r.rulegen_version === undefined || typeof r.rulegen_version === "string", "rulegen_version must be a string");
  return r;
}

export const checksumHex = (hash: string, r: DynamicRules) =>
  Math.abs(r.checksum_indexes.reduce((s, i) => s + hash.charCodeAt(i), r.checksum_constant)).toString(16);
