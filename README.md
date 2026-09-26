[![Generate dynamic rules](https://github.com/mikigoalie/onlyfans-rulegen/actions/workflows/update.yml/badge.svg)](https://github.com/mikigoalie/onlyfans-rulegen/actions/workflows/update.yml)

This repo fetches OnlyFans' obfuscated request-signing module and extracts the
dynamic signing rules ([dynamic-rules.json](dynamic-rules.json)).

Instead of statically deobfuscating the script, it **executes** the signing
module in a `vm` sandbox with its dependencies swapped for stubs. The SHA-1
hasher is forced to return hash strings we choose, and the checksum is probed
one hash position at a time to recover the index multiset and the constant.

## Verification gate

Rules are only written after they pass every check:

- **Probe checks.** The checksum must be linear per position, additive across
  positions and a function of the hash alone. The module must use the hash it
  was given as-is. Every per-position delta must be a non-negative integer.
- **Shape checks.** `prefix` is numeric, `suffix` is 8 hex characters,
  `checksum_indexes` is non-empty, sorted and within 0–39, `checksum_constant`
  is an integer, and `revision` matches `^\d{12}-[a-f0-9]{10}$`.
- **Self-verification.** The module is loaded again with real SHA-1 and signs
  500 random paths (query strings, unicode) as random user ids. Every signature
  must equal what the rules predict. The first mismatch fails the run.

## Output compatibility

The output format only grows. These keys keep their name, type and meaning:

`end`, `start`, `format`, `prefix`, `suffix`, `revision`, `app_token`,
`static_param`, `remove_headers`, `checksum_indexes`, `checksum_constant`

New keys may be added. Today these are `verified_samples` (signatures checked
before publishing) and `rulegen_version`.

## Usage

Requires Node 26.

```sh
npm install
npm test         # build, then extract + verify every sample in samples/obfuscated/
npm run fetch -- --curl /path/to/curl_chrome150   # fetch the live build and write dynamic-rules.json
npm run dynamic-rules -- <obfuscated-script.js> <app_token>
```

Cloudflare blocks plain `curl`, so pass a
[curl-impersonate](https://github.com/lexiforest/curl-impersonate) binary with
`--curl` (or `$CURL`). `npm run fetch` fetches the homepage once. If the
revision matches the committed `dynamic-rules.json` it stops there; otherwise it
downloads the chunk and `app.js`, writes `dynamic-rules.json` and saves the
chunk to `samples/obfuscated/<revision>.js`. Pass `--force` to re-extract an
unchanged revision.

## CI and security model

[update.yml](.github/workflows/update.yml) runs hourly. `vm` is not a security
boundary, so the untrusted chunk only runs in a job that can't write anything:

- **extract** has `contents: read`, no persisted credentials and no secrets. It
  runs `npm test`, fetches, extracts, verifies, and uploads the rules and the
  raw chunk as an artifact.
- **publish** has `contents: write`. It re-validates the rules' shape with a
  script that never runs the OnlyFans code, then commits `dynamic-rules.json`
  and `samples/obfuscated/<revision>.js` together. Nothing is committed if they
  are unchanged.

Every OnlyFans build is kept in `samples/obfuscated/`, so it becomes a
regression case for `npm test`. A failed extraction or validation never touches
the committed `dynamic-rules.json`.

## Failures

When a run fails, the workflow opens an issue labelled `rulegen-failure` (or
comments on the open one) with the error and a link to the run. The next
successful run closes it.

Please do not ask how to sign onlyfans requests, I will not respond.
