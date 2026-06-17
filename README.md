
[![Generate dynamic rules](https://github.com/mikigoalie/onlyfans-rulegen/actions/workflows/update.yml/badge.svg)](https://github.com/mikigoalie/onlyfans-rulegen/actions/workflows/update.yml)

This repo fetches OnlyFans' obfuscated request-signing module and extracts the
dynamic signing rules ([dynamic-rules.json](dynamic-rules.json)).

Instead of statically deobfuscating the script, it **executes** the obfuscated
signing module inside a sandbox and reads the rules straight out of the real
`sign` function: the dependencies (the SHA-1 hasher and lodash `get`) are
stubbed so the hash string is fully controlled, then the checksum function is
probed one hash position at a time to recover the index multiset and the
additive constant. Running the browser-correct code as-is means the output is
correct by construction and self-heals when OnlyFans rotates their obfuscation.

## Usage

```sh
npm install
npm run build

# Fetch the current script + app token and regenerate dynamic-rules.json:
npm run fetch

# ...or extract from a script you already have on disk:
npm run dynamic-rules -- <obfuscated-script.js> <app_token>
```

`npm run fetch` shells out to the system `curl` (Cloudflare blocks Node's
built-in fetch via TLS fingerprinting). It downloads the signing chunk, pulls
the app token from `app.js`, saves the raw chunk under `samples/obfuscated/`,
and writes `dynamic-rules.json`.

The GitHub Actions workflow ([.github/workflows/update.yml](.github/workflows/update.yml))
does the same on a schedule using curl-impersonate, and commits the result
whenever OnlyFans ships a new build.

Please do not ask how to sign onlyfans requests, I will not respond.
