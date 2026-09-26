import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAppToken, parseHomepage } from "../fetch";

const url = (rev: string, c = "2313") => `https://static2.onlyfans.com/static/prod/f/${rev}/${c}.js`;

test("parseHomepage takes the first script URL and accepts any 20xx year", () => {
  const html = `<script src="${url("203101021314-0123456789")}"></script><script src="${url("202601021314-abcdefabcd", "1111")}"></script>`;
  assert.deepEqual(parseHomepage(html), {
    scriptUrl: url("203101021314-0123456789"),
    revision: "203101021314-0123456789",
    appJsUrl: "https://static2.onlyfans.com/static/prod/f/203101021314-0123456789/app.js",
  });
});

test("parseHomepage reports a Cloudflare challenge", () => {
  assert.throws(() => parseHomepage("<title>Just a moment...</title>"), /Cloudflare/);
  assert.throws(() => parseHomepage("<html></html>"), /Could not find/);
});

test("extractAppToken follows the app-token header to its variable", () => {
  const js = `,Xe="ffffffffffffffffffffffffffffffff",Pe="33d57ade8c02dbc5a333db99ff9ae26a",Ce=1;nt=async e=>{const t={};t["app-token"]=Pe;}`;
  assert.equal(extractAppToken(js), "33d57ade8c02dbc5a333db99ff9ae26a");
});

test("extractAppToken accepts a literal and an object-literal header", () => {
  assert.equal(extractAppToken(`t["app-token"]="0123456789abcdef0123456789abcdef"`), "0123456789abcdef0123456789abcdef");
  assert.equal(extractAppToken(`const Q$="0123456789abcdef0123456789abcdef";h={"app-token":Q$}`), "0123456789abcdef0123456789abcdef");
});

test("extractAppToken fails loudly when the anchor is missing or ambiguous", () => {
  assert.throws(() => extractAppToken(`,Pe="33d57ade8c02dbc5a333db99ff9ae26a"`), /Could not find/);
  assert.throws(() => extractAppToken(`Pe="0123456789abcdef0123456789abcdef";Pe="33d57ade8c02dbc5a333db99ff9ae26a";t["app-token"]=Pe`), /2 different/);
});
