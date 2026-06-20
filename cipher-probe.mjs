#!/usr/bin/env node
/**
 * cipher-probe.mjs — try to crack the PX payload encoding.
 *
 * Reads results/mitm.json, base64-decodes each `payload=` body, then runs
 * frequency analysis + XOR-with-candidate-key trials to see if the cleartext
 * is recoverable without bundle-patching.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BODIES = join(__dirname, "results/mitm-bodies");

// Load every <NN>-collector.bin (request bodies, NOT responses).
const files = readdirSync(BODIES).filter((f) => /^\d+-collector\.bin$/.test(f)).sort();
console.log(`bodies: ${files.length}`);

// Each body is `payload=<base64>` urlencoded.
const decoded = files.map((f) => {
  const raw = readFileSync(join(BODIES, f), "utf8");
  const m = raw.match(/^payload=(.+)$/s);
  if (!m) return { f, error: "no payload= prefix" };
  // urlencoded — but base64 chars don't need decoding mostly; still, decode it.
  const b64 = decodeURIComponent(m[1]);
  try {
    const bytes = Buffer.from(b64, "base64");
    return { f, b64len: b64.length, bytes };
  } catch (e) {
    return { f, error: e.message };
  }
});

// 1. Find common prefix across all bodies.
const buffers = decoded.filter((d) => d.bytes).map((d) => d.bytes);
let commonLen = 0;
outer: for (let i = 0; i < buffers[0].length; i++) {
  for (const b of buffers) {
    if (b[i] !== buffers[0][i]) break outer;
  }
  commonLen++;
}
const commonPrefix = buffers[0].slice(0, commonLen);
console.log(`\ncommon prefix length: ${commonLen} bytes`);
console.log(`common prefix hex:    ${commonPrefix.toString("hex")}`);
console.log(`common prefix ascii:  ${JSON.stringify(commonPrefix.toString("latin1"))}`);

// 2. Byte-frequency analysis on the first body.
const freq = new Array(256).fill(0);
for (const b of buffers[0]) freq[b]++;
const top = freq
  .map((c, b) => ({ b, c }))
  .filter((x) => x.c > 0)
  .sort((a, b) => b.c - a.c);
console.log(`\ntop 10 byte values in body 0 (${buffers[0].length} bytes):`);
top.slice(0, 10).forEach((x) =>
  console.log(`  0x${x.b.toString(16).padStart(2, "0")} (${String.fromCharCode(x.b) || "?"})  ${x.c}  ${((x.c / buffers[0].length) * 100).toFixed(1)}%`),
);

// 3. Single-byte XOR sweep — find a key that maximizes printable-ASCII ratio.
function printableRatio(buf, key) {
  let ok = 0;
  for (const b of buf) {
    const c = b ^ key;
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) ok++;
  }
  return ok / buf.length;
}

const sample = buffers[0].slice(0, 1000);
const singleByteXor = [];
for (let k = 0; k < 256; k++) {
  singleByteXor.push({ k, ratio: printableRatio(sample, k) });
}
singleByteXor.sort((a, b) => b.ratio - a.ratio);
console.log(`\nsingle-byte XOR sweep (top 5 keys by printable-ratio):`);
singleByteXor.slice(0, 5).forEach((x) =>
  console.log(`  key=0x${x.k.toString(16).padStart(2, "0")} (${String.fromCharCode(x.k)})  ratio=${(x.ratio * 100).toFixed(1)}%`),
);

// 4. Try XOR with candidate cleartext prefixes — recover key, check rest.
const candidates = [
  `{"PX8FCGYgk4":`,
  `{"appId":"PX`,
  `app_id=PX8FCG`,
  `payload[]={"`,
  `PX8FCGYgk4{`,
  `\x00PX8FCGYgk4`,
  `\x01PX8FCGYgk4`,
  `\x00\x00PX8FCG`,
  `appId="PX`,
  `{"a":"PX8FCG`,
  `appId\x00PX`,
];
console.log(`\nXOR-with-cleartext-prefix candidates:`);
for (const cand of candidates) {
  const cb = Buffer.from(cand, "latin1");
  const klen = Math.min(cb.length, commonPrefix.length);
  const key = Buffer.alloc(klen);
  for (let i = 0; i < klen; i++) key[i] = commonPrefix[i] ^ cb[i];
  // Apply the recovered key (repeating) to the rest of body 0 and check
  // printable ratio of the resulting next chunk.
  const rest = buffers[0].slice(klen, klen + 200);
  const decode = Buffer.alloc(rest.length);
  for (let i = 0; i < rest.length; i++) decode[i] = rest[i] ^ key[i % klen];
  const printable = printableRatio(decode, 0);
  console.log(
    `  cand=${JSON.stringify(cand.slice(0, 16))}...  key=${key.toString("hex")}  next-200-printable=${(printable * 100).toFixed(0)}%`,
  );
}

// 5. Save the common prefix for inspection.
writeFileSync(join(__dirname, "results/cipher-probe.json"), JSON.stringify({
  bodies: files.length,
  commonPrefixHex: commonPrefix.toString("hex"),
  commonPrefixAscii: commonPrefix.toString("latin1"),
  topBytes: top.slice(0, 16),
  bestSingleByteXor: singleByteXor.slice(0, 5),
}, null, 2));
