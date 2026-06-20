#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const j = JSON.parse(readFileSync(join(__dirname, "results/strings.json"), "utf8"));

const patterns = [
  // Network / endpoints
  /collector/i, /perimeterx/i, /humansec/i, /\/xhr/i, /\/init/i,
  // PX cookies / params
  /_px/, /pxhd/, /pxvid/, /pxcts/, /pxde/, /appId/, /8FCG/,
  // Browser / fingerprint surfaces
  /navigator/i, /webdriver/i, /userAgent/i, /plugins/, /mimeTypes/,
  /canvas/i, /webgl/i, /WebGL/, /fillRect/, /toDataURL/, /measureText/, /getImageData/,
  /screen\b/, /innerWidth/, /innerHeight/, /outerWidth/, /outerHeight/, /devicePixelRatio/,
  /deviceMemory/, /hardwareConcurrency/, /maxTouchPoints/, /platform/,
  // Behavioral
  /touchstart/, /mousemove/, /MutationObserver/, /pointerdown/, /keydown/,
  // Media / sensors
  /battery/, /gamepad/, /mediaDevices/, /permissions/, /getUserMedia/, /RTCPeerConnection/,
  /AudioContext/, /OfflineAudio/, /speechSynthesis/,
  // CDP / automation tells
  /cdc_/, /\$cdc/, /automationControlled/, /HeadlessChrome/, /__nightmare/, /phantom/i,
  /selenium/i, /webdriver_/,
  // Crypto / hashing
  /sha-?256/i, /HMAC/, /crypto/i, /subtle/i, /getRandomValues/,
  // Workers / iframes
  /Worker\b/, /SharedWorker/, /ServiceWorker/, /postMessage/, /iframe/i,
  // Storage
  /cookie/, /localStorage/, /sessionStorage/, /indexedDB/,
  // Common HTTP
  /^(POST|GET|PUT|DELETE)$/, /Content-Type/i, /X-Px/i,
  // Network info
  /connection/, /effectiveType/, /downlink/, /rtt/,
];

const labels = new Map();
for (const e of j.entries) {
  const p = e.plain;
  if (!p || p.length < 2) continue;
  for (const re of patterns) {
    if (re.test(p)) {
      labels.set(e.idx, p);
      break;
    }
  }
}

console.log(`${labels.size}/${j.count} matches\n`);
const sorted = [...labels].sort((a, b) => a[0] - b[0]);
for (const [idx, p] of sorted) {
  const trim = p.length > 100 ? p.slice(0, 100) + "..." : p;
  console.log(`  [${String(idx).padStart(4)}] ${trim}`);
}

writeFileSync(
  join(__dirname, "results/strings-interesting.json"),
  JSON.stringify(Object.fromEntries(sorted), null, 2),
);
