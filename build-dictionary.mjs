#!/usr/bin/env node
/**
 * build-dictionary.mjs — map PX's 8-byte hashed signal names to their real
 * meanings by scanning the bundle.
 *
 * The hashed names ("AW1zJ0cBdhc=") are hardcoded as string literals in
 * init.js. They're used at the call site where the real signal value is
 * computed:
 *
 *   collect("AW1zJ0cBdhc=", someExpression)
 *   obj["InJQeGcTUEI="] = navigator.platform
 *   ...etc
 *
 * We grep the bundle for each hash, extract a window of context around it,
 * and look for the source expression. Plaintext property names that appear
 * near each hash (navigator.userAgent, screen.width, etc.) are strong
 * candidates for the meaning.
 *
 * Usage: node build-dictionary.mjs
 *   reads results/signals.json + results/bundle-8FCGYgk4-init.js
 *   writes results/dictionary.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(__dirname, "results/bundle-8FCGYgk4-init.js"), "utf8");
const signalIndex = JSON.parse(readFileSync(join(__dirname, "results/signals.json"), "utf8"));
const strings = JSON.parse(readFileSync(join(__dirname, "results/strings.json"), "utf8"));

// Index decoded strings by their location-of-use: we want to know, when we
// see kc(N) near a hash, what the decoded string at N is.
const decodedAt = new Map();
for (const e of strings.entries) {
  decodedAt.set(e.idx, e.plain);
}

// Common fingerprinting property names to recognize in context.
const KNOWN_PROPS = [
  "userAgent", "platform", "appCodeName", "appName", "appVersion", "vendor",
  "vendorSub", "product", "productSub", "language", "languages", "doNotTrack",
  "cookieEnabled", "javaEnabled", "hardwareConcurrency", "deviceMemory",
  "maxTouchPoints", "webdriver", "plugins", "mimeTypes", "permissions",
  "mediaDevices", "connection", "geolocation", "credentials", "clipboard",
  "screen", "width", "height", "availWidth", "availHeight", "colorDepth",
  "pixelDepth", "innerWidth", "innerHeight", "outerWidth", "outerHeight",
  "devicePixelRatio", "documentElement", "scrollWidth", "scrollHeight",
  "canvas", "toDataURL", "getImageData", "fillRect", "measureText", "fillText",
  "WebGLRenderingContext", "getParameter", "getExtension", "getSupportedExtensions",
  "AudioContext", "OfflineAudioContext", "createOscillator", "createAnalyser",
  "TextEncoder", "fonts", "speechSynthesis", "battery", "getBattery",
  "ondevicemotion", "ondeviceorientation", "DeviceOrientationEvent",
  "RTCPeerConnection", "createDataChannel", "createOffer",
  "performance", "now", "timeOrigin", "getEntriesByType", "navigation",
  "memory", "totalJSHeapSize", "usedJSHeapSize", "jsHeapSizeLimit",
  "MutationObserver", "IntersectionObserver", "ResizeObserver",
  "innerText", "innerHTML", "outerHTML", "textContent", "title", "referrer",
  "location", "href", "origin", "host", "hostname", "protocol", "pathname",
  "history", "localStorage", "sessionStorage", "indexedDB", "openDatabase",
  "Worker", "SharedWorker", "ServiceWorker", "postMessage", "MessageChannel",
  "iframe", "contentWindow", "contentDocument", "frameElement", "top", "parent",
  "Notification", "PushManager", "Bluetooth", "USB", "Serial", "HID", "NDEFReader",
  "chrome", "webstore", "runtime", "loadTimes", "csi",
  "TouchEvent", "PointerEvent", "InputDeviceCapabilities", "VisualViewport",
  "Reflect", "Proxy", "Symbol", "Map", "Set", "WeakMap", "WeakSet",
  "console", "log", "warn", "error", "debug",
  "Function", "toString", "Date", "now",
  "Math", "random", "round", "floor", "ceil",
  "Object", "keys", "values", "entries", "getOwnPropertyNames", "getPrototypeOf",
  // Mouse / keyboard event types
  "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "click",
  "dblclick", "keydown", "keyup", "keypress", "touchstart", "touchmove",
  "touchend", "pointerdown", "pointerup", "pointermove", "wheel", "scroll",
  "focus", "blur", "submit", "change", "input", "resize", "beforeunload",
  "visibilitychange", "pagehide", "pageshow",
];

const dictionary = [];
for (const sig of signalIndex.signals) {
  const hash = sig.hash;
  // Find the literal in the bundle.
  const lit = '"' + hash + '"';
  const idx = bundle.indexOf(lit);
  if (idx < 0) {
    dictionary.push({ hash, count: sig.count, found: false, samples: sig.samples });
    continue;
  }
  // 200-byte context window each side.
  const start = Math.max(0, idx - 200);
  const end = Math.min(bundle.length, idx + lit.length + 200);
  const ctx = bundle.slice(start, end);

  // Look for known property-name occurrences in the context.
  const propsFound = new Set();
  for (const p of KNOWN_PROPS) {
    if (new RegExp("\\b" + p + "\\b").test(ctx)) propsFound.add(p);
  }
  // Also pull any kc(N) references and resolve them.
  const kcRefs = [...ctx.matchAll(/kc\((\d+)\)/g)].map((m) => parseInt(m[1]));
  const kcResolved = kcRefs
    .map((n) => decodedAt.get(n))
    .filter((s) => s && /^[A-Za-z_$][A-Za-z0-9_$]{1,40}$/.test(s));

  dictionary.push({
    hash,
    count: sig.count,
    found: true,
    bundleOffset: idx,
    propsInContext: [...propsFound],
    kcResolved,
    samples: sig.samples,
    context: ctx.slice(190, 230),
  });
}

const found = dictionary.filter((d) => d.found && (d.propsInContext.length || d.kcResolved.length));
console.log(`hashes with property/kc-resolved context: ${found.length} / ${dictionary.length}`);

// Sort by signal frequency and print the high-confidence matches.
const ranked = dictionary.filter((d) => d.found).sort((a, b) => b.count - a.count);
console.log(`\nTop 40 captured signals with bundle context:`);
for (const d of ranked.slice(0, 40)) {
  const guess = [
    ...d.kcResolved.slice(0, 4),
    ...d.propsInContext.slice(0, 6),
  ].join(", ");
  const sample = (d.samples[0] || "").slice(0, 40);
  console.log(`  ${d.hash}  (${d.count}×)`);
  console.log(`    sample: ${JSON.stringify(sample)}`);
  console.log(`    guess:  ${guess || "(no recognized names)"}`);
}

writeFileSync(
  join(__dirname, "results/dictionary.json"),
  JSON.stringify({ total: dictionary.length, withMatches: found.length, entries: dictionary }, null, 2),
);
console.log(`\n  → results/dictionary.json`);
