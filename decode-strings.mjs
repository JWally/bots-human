#!/usr/bin/env node
/**
 * decode-strings.mjs — pull HUMAN/PX's base91 string table out of init.js
 *
 * The bundle ships an obfuscated string array (`ke=[...]`) and a base91
 * decoder (`kb`) with a permuted alphabet hardcoded at the top. Lazy
 * decoder `kc(t)` returns `kb(ke[t])` on first read.
 *
 * This script extracts the alphabet + ke[] array via regex, decodes every
 * entry, and dumps `results/strings.json` (idx → plaintext).
 *
 * Usage: node decode-strings.mjs [path-to-bundle]
 *   default: results/bundle-8FCGYgk4-init.js
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(__dirname, "results/bundle-8FCGYgk4-init.js");
const src = readFileSync(path, "utf8");

// Pull the alphabet — it's the single-quoted 91-char string inside kb()
// containing the `.indexOf(n[a])` call.
const alphaMatch = src.match(/'([^']{91})'\.indexOf\(/);
if (!alphaMatch) {
  console.error("Could not locate base91 alphabet (no 91-char .indexOf source).");
  process.exit(1);
}
const ALPHA = alphaMatch[1];
console.log(`alphabet: ${ALPHA}`);
console.log(`alphabet length: ${ALPHA.length}`);

// Pull the ke=[...] array. The array contents are JS-quoted strings (mixed
// single / double / backtick), comma-separated. Use a tolerant capture:
// find `var ke=[` (or `,ke=[`), then balance the brackets manually.
const keMatch = src.match(/[,\s;]ke\s*=\s*\[/);
if (!keMatch) {
  console.error("Could not find ke=[ array.");
  process.exit(1);
}
let i = keMatch.index + keMatch[0].length;
let depth = 1;
let inStr = null;
let escape = false;
const start = i;
while (i < src.length && depth > 0) {
  const c = src[i];
  if (escape) {
    escape = false;
  } else if (inStr) {
    if (c === "\\") escape = true;
    else if (c === inStr) inStr = null;
  } else {
    if (c === "'" || c === '"' || c === "`") inStr = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  i++;
}
const arrayBody = src.slice(start, i - 1); // exclude the closing ]

// Parse the array body into individual strings. We can't naively split on
// commas — strings contain commas. Iterate, respecting quote state.
const items = [];
{
  let buf = "";
  let inStr2 = null;
  let escape2 = false;
  let inItem = false;
  for (let j = 0; j < arrayBody.length; j++) {
    const c = arrayBody[j];
    if (!inItem) {
      if (c === "'" || c === '"' || c === "`") {
        inStr2 = c;
        inItem = true;
        buf = "";
      }
      continue;
    }
    if (escape2) {
      buf += c;
      escape2 = false;
    } else if (c === "\\") {
      escape2 = true;
      buf += c;
    } else if (c === inStr2) {
      items.push(buf);
      inItem = false;
      inStr2 = null;
    } else {
      buf += c;
    }
  }
}

console.log(`ke[] length: ${items.length}`);

// Implement kb(t): base91 decode using the bundled alphabet, then map to a
// string. The bundle's `kn(r)` final step takes an array of bytes and joins
// them into a string via String.fromCharCode. We replicate inline.
function kb(t, alpha) {
  const n = "" + (t || "");
  const e = n.length;
  const r = [];
  let k = 0;
  let o = 0;
  let i = -1;
  for (let a = 0; a < e; a++) {
    const c = alpha.indexOf(n[a]);
    if (c === -1) continue;
    if (i < 0) i = c;
    else {
      let acc = i + 91 * c;
      k |= acc << o;
      o += (acc & 8191) > 88 ? 13 : 14;
      do {
        r.push(255 & k);
        k >>= 8;
        o -= 8;
      } while (o > 7);
      i = -1;
    }
  }
  if (i > -1) r.push(255 & (k | (i << o)));
  return Buffer.from(r).toString("utf8");
}

const decoded = items.map((s, idx) => ({ idx, raw: s, plain: kb(s, ALPHA) }));

writeFileSync(
  join(__dirname, "results/strings.json"),
  JSON.stringify({ alphabet: ALPHA, count: decoded.length, entries: decoded }, null, 2),
);

// Print interesting ones: URLs, headers, PX-related identifiers
const interesting = decoded.filter((d) =>
  /collector-|perimeterx|pxhd|pxvid|_px|appId|init\.js|xhr|POST|GET|navigator|webdriver|chrome|userAgent|plugins|canvas|webgl|screen|innerWidth/i.test(
    d.plain,
  ),
);

console.log(`\ninteresting strings (${interesting.length}):`);
for (const d of interesting.slice(0, 60)) {
  const preview = d.plain.length > 100 ? d.plain.slice(0, 100) + "..." : d.plain;
  console.log(`  [${String(d.idx).padStart(4)}] ${preview}`);
}
if (interesting.length > 60) console.log(`  ... + ${interesting.length - 60} more`);

console.log(`\n  full table → results/strings.json`);
