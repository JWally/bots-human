#!/usr/bin/env node
/**
 * decrypt.mjs — decode every PX collector POST captured by mitm.mjs.
 *
 * The cipher is a single-byte XOR with 0x32 (discovered 2026-05-24 via
 * common-prefix analysis: XOR'ing the constant 7-byte ciphertext prefix
 * gave `[{"t":"`, which is JSON). No keying material, no MAC. The body
 * format after XOR + base64-decode is:
 *
 *   [{"t":"<8-byte-base64>","d":{"<8-byte-base64-name>": <value>, ...}}]
 *
 * `t` and the `d` keys are hashed signal names (probably truncated
 * SHA-256 or HMAC, 8 bytes / 64 bits). Values are clear (strings,
 * numbers, booleans, nested objects).
 *
 * Usage: node decrypt.mjs
 *   reads results/mitm-bodies/*-collector.bin, writes results/decrypted/
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BODIES = join(__dirname, "results/mitm-bodies");
const OUT = join(__dirname, "results/decrypted");
mkdirSync(OUT, { recursive: true });

const KEY = 0x32;
const files = readdirSync(BODIES).filter((f) => /^\d+-collector\.bin$/.test(f)).sort();

const summary = [];
const signalIndex = new Map();

for (const f of files) {
  const raw = readFileSync(join(BODIES, f), "utf8");
  const head = raw.match(/^payload=(.+)$/s);
  if (!head) continue;
  const b64 = decodeURIComponent(head[1]);
  const enc = Buffer.from(b64, "base64");
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) dec[i] = enc[i] ^ KEY;

  writeFileSync(join(OUT, f.replace(".bin", ".json")), dec);

  // Strict JSON.parse rejects PX's wire format because it embeds raw bytes
  // (canvas / webgl hashes) inside string values. Instead of trying to fix
  // up the syntax, regex out every `"<12-base64-char-key>":<value>` we can
  // see. Values are matched non-greedy until the next key or end-of-object.
  // This is good enough to build the signal-name index, even if we lose
  // the strict nesting structure.
  const text = dec.toString("latin1");
  const keyValueRe = /"([A-Za-z0-9+/]{10,12}=?)"\s*:\s*("(?:[^"\\]|\\.)*?"|true|false|null|-?\d+(?:\.\d+)?|\{[^{}]*\}|\[[^\[\]]*\])/g;
  let fieldCount = 0;
  let m;
  while ((m = keyValueRe.exec(text)) !== null) {
    const hash = m[1];
    const rawValue = m[2];
    fieldCount++;
    if (!signalIndex.has(hash)) signalIndex.set(hash, { count: 0, samples: [] });
    const e = signalIndex.get(hash);
    e.count++;
    if (e.samples.length < 3) {
      let s = rawValue;
      // Strip the wrapping quotes if it's a string value.
      if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      // Replace control bytes with `·` for display.
      s = s.replace(/[\x00-\x1f\x7f-\xff]/g, "·");
      if (s.length > 100) s = s.slice(0, 100) + "...";
      if (!e.samples.includes(s)) e.samples.push(s);
    }
  }

  summary.push({
    file: f,
    encryptedSize: enc.length,
    fieldCount,
  });
}

console.log(`decrypted ${files.length} bodies → ${OUT}/`);
summary.forEach((s) =>
  console.log(`  ${s.file}  enc=${s.encryptedSize}B  fields=${s.fieldCount}`),
);

const allSignals = [...signalIndex]
  .sort((a, b) => b[1].count - a[1].count)
  .map(([hash, info]) => ({ hash, count: info.count, samples: info.samples }));

console.log(`\nunique hashed-signal names: ${allSignals.length}`);
console.log(`top 30 by frequency:`);
allSignals.slice(0, 30).forEach((s, i) => {
  const sampleStr = s.samples
    .map((v) => (typeof v === "string" ? JSON.stringify(v) : v))
    .join(" | ");
  console.log(`  [${i + 1}] ${s.hash}  (${s.count}×)  samples: ${sampleStr}`);
});

writeFileSync(
  join(__dirname, "results/signals.json"),
  JSON.stringify({ signalCount: allSignals.length, signals: allSignals }, null, 2),
);
console.log(`\n  signal index → results/signals.json`);
