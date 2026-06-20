#!/usr/bin/env node
/**
 * recon.mjs — find HUMAN / PerimeterX's sensor on a target page and report
 * what we can about it.
 *
 * Loads a target URL with Playwright real Chrome, logs every JS response,
 * flags first-party `/{appId}/init.js` chunks (PX's first-party-proxied
 * sensor), records the appId, dumps the bundle to disk, and probes for
 * PX globals + cookies after load. Also captures any collector / xhr POST
 * the sensor makes (the telemetry endpoint).
 *
 * Usage: node recon.mjs [target-url]
 *   default target: a Bloomberg article (confirmed PX-protected)
 */

import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "results");
mkdirSync(OUT, { recursive: true });

const TARGET =
  process.argv[2] ||
  "https://www.bloomberg.com/news/articles/2026-05-23/deepseek-to-make-permanent-75-discount-on-flagship-ai-model";

const userDataDir = mkdtempSync(join(tmpdir(), "px-recon-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1366, height: 900 },
});
const page = await ctx.newPage();

const jsResponses = [];
const xhrPosts = [];
const initJsBodies = new Map(); // url -> body
let challengePage = false;

page.on("response", async (resp) => {
  const u = resp.url();
  const ct = resp.headers()["content-type"] || "";
  if (/javascript|application\/json/.test(ct) || /\.js(\?|$)/.test(u)) {
    jsResponses.push({
      url: u,
      status: resp.status(),
      bytes: parseInt(resp.headers()["content-length"] || "0"),
    });
  }
  // PX first-party sensor: /{8-char-id}/init.js — capture the body.
  // Also captures /{id}/captcha/captcha.js if served on the challenge page.
  if (/\/[A-Za-z0-9_-]{6,12}\/(init|captcha\/captcha)\.js(\?|$)/.test(u)) {
    try {
      const body = (await resp.body()).toString("utf8");
      initJsBodies.set(u, body);
    } catch {}
  }
});

page.on("request", (req) => {
  if (req.method() === "POST") {
    const u = req.url();
    // PX collector endpoints (first-party proxied or perimeterx.net direct)
    if (
      /perimeterx\.net|\/[A-Za-z0-9_-]{6,12}\/(xhr|collect|tt)/.test(u) ||
      /humansecurity/.test(u)
    ) {
      xhrPosts.push({
        url: u,
        method: req.method(),
        postDataLength: (req.postData() || "").length,
        contentType: req.headers()["content-type"] || "",
      });
    }
  }
});

console.log(`recon: loading ${TARGET}`);
const r = await page
  .goto(TARGET, { waitUntil: "load", timeout: 30000 })
  .catch((e) => ({ status: () => "err", _err: e.message }));
console.log(`  HTTP ${r.status?.() ?? "?"}  title="${await page.title()}"`);
challengePage = /robot|captcha|press.{0,4}hold/i.test(await page.title());

// Let the sensor run.
await page.waitForTimeout(6000);

// Probe PX globals + cookies in the page.
const probe = await page
  .evaluate(() => {
    const out = {};
    const keys = Object.keys(window).filter((k) => /^_?px/i.test(k));
    out.pxGlobals = {};
    for (const k of keys) {
      try {
        const v = window[k];
        out.pxGlobals[k] =
          typeof v === "function"
            ? "[function]"
            : typeof v === "object"
              ? JSON.stringify(v).slice(0, 200)
              : String(v).slice(0, 200);
      } catch {
        out.pxGlobals[k] = "[unreadable]";
      }
    }
    out.cookies = document.cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => /^_?px/i.test(c));
    out.captchaWidget = !!document.getElementById("px-captcha");
    return out;
  })
  .catch(() => ({ error: "probe failed" }));

const pxJsResponses = jsResponses.filter(
  (j) =>
    /perimeterx\.net/.test(j.url) ||
    /\/[A-Za-z0-9_-]{6,12}\/(init|captcha)/.test(j.url),
);

console.log(`\nPX-related JS responses (${pxJsResponses.length}):`);
pxJsResponses.forEach((j) => console.log(`  ${j.status}  ${j.url}`));

console.log(`\nPX-related XHR POSTs (${xhrPosts.length}):`);
xhrPosts.forEach((x) =>
  console.log(`  ${x.method}  ${x.url}  ct=${x.contentType}  len=${x.postDataLength}`),
);

// Per-bundle signature inspection.
const bundles = [];
for (const [u, body] of initJsBodies) {
  const appIdMatch = u.match(/\/([A-Za-z0-9_-]{6,12})\/(?:init|captcha)/);
  const sig = {
    url: u,
    bytes: body.length,
    appId: appIdMatch ? appIdMatch[1] : null,
    has_pxAppId: /_pxAppId|appId/i.test(body),
    has_pxhd: /_pxhd|pxvid|_px3/i.test(body),
    has_collector: /collector-/i.test(body),
    // VM signal: dispatcher loops over a big switch on an opcode register.
    // Common shapes: `while(true)switch(_0x...)`, large string arrays, hex names.
    has_dispatcher: /while\s*\(\s*(true|!!?\[\])\s*\)\s*\{[^}]*switch/.test(body),
    big_string_array_count: (body.match(/=\['/g) || []).length,
    hex_identifier_count: (body.match(/_0x[a-f0-9]{4,6}/g) || []).length,
    has_eval: /\beval\(/.test(body),
    has_Function_ctor: /new Function\(/.test(body),
  };
  bundles.push(sig);
  const dumpPath = join(
    OUT,
    `bundle-${(sig.appId || "unknown")}-${u.match(/\/(init|captcha)/)[1]}.js`,
  );
  writeFileSync(dumpPath, body);
  sig.dumpedTo = dumpPath;
}

console.log(`\nPX bundles captured (${bundles.length}):`);
for (const b of bundles) {
  console.log(`  ${b.url}`);
  console.log(`    appId:         ${b.appId}`);
  console.log(`    bytes:         ${b.bytes}`);
  console.log(`    pxAppId ref:   ${b.has_pxAppId ? "✓" : "✗"}`);
  console.log(`    px cookie ref: ${b.has_pxhd ? "✓" : "✗"}`);
  console.log(`    collector ref: ${b.has_collector ? "✓" : "✗"}`);
  console.log(`    dispatcher:    ${b.has_dispatcher ? "VM SHAPE ✓" : "✗"}`);
  console.log(`    hex idents:    ${b.hex_identifier_count}`);
  console.log(`    string arrays: ${b.big_string_array_count}`);
  console.log(`    eval:          ${b.has_eval ? "✓" : "✗"}`);
  console.log(`    Function ctor: ${b.has_Function_ctor ? "✓" : "✗"}`);
  console.log(`    dumped:        ${b.dumpedTo}`);
}

console.log(`\nin-page probe:`);
console.log(`  challenge page:  ${challengePage}`);
console.log(`  px-captcha el:   ${probe.captchaWidget ? "✓" : "✗"}`);
console.log(`  PX globals:      ${Object.keys(probe.pxGlobals || {}).join(", ") || "(none)"}`);
console.log(`  PX cookies:      ${(probe.cookies || []).join(" ; ") || "(none)"}`);

writeFileSync(
  join(OUT, "recon.json"),
  JSON.stringify(
    {
      target: TARGET,
      finalStatus: r.status?.() ?? null,
      challengePage,
      jsResponseCount: jsResponses.length,
      pxJsResponses,
      xhrPosts,
      bundles,
      probe,
      capturedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

await ctx.close();
console.log(`\n  artifacts → ${OUT}/recon.json + bundle-*.js dumps`);
