#!/usr/bin/env node
/**
 * mitm.mjs — capture HUMAN/PX's collector POST(s) from a target page.
 *
 * Two stages:
 *   Stage A (passive): launch real Chrome via Playwright, perform humanlike
 *     activity for ~25s, capture every POST to /8FCGYgk4/xhr (first-party
 *     proxy) or collector-PX*.px-cloud.net. Save bodies raw.
 *
 *   Stage B (bundle patch): if Stage A captures POSTs, we can decode/
 *     understand the format from the bodies. If not (or as a complement),
 *     intercept init.js in flight and inject a tap at the encoder entry —
 *     this captures the cleartext payload before it's serialized.
 *
 * For the first pass we run Stage A only — needs to know if POSTs even
 * fire in a normal pageview before we go after the encoder.
 *
 * Usage: node mitm.mjs [target-url]
 *   default: a Bloomberg article (PX-protected)
 */

import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "results");
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "mitm-bodies"), { recursive: true });

const TARGET =
  process.argv[2] ||
  "https://www.bloomberg.com/news/articles/2026-05-23/deepseek-to-make-permanent-75-discount-on-flagship-ai-model";

const PX_PATH_RE = /\/[A-Za-z0-9_-]{6,12}\/(xhr|collect|b\/s|tt)(\?|$|\/)/;
const PX_HOST_RE = /\b(collector|tzm|captcha)[-A-Za-z0-9_]*\.px-(cloud|cdn|client|chk)\.net/;

const userDataDir = mkdtempSync(join(tmpdir(), "px-mitm-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1366, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await ctx.newPage();

const posts = [];

page.on("request", (req) => {
  if (req.method() !== "POST") return;
  const u = req.url();
  if (!(PX_PATH_RE.test(u) || PX_HOST_RE.test(u))) return;
  const postData = req.postData() || "";
  const postDataBuf = req.postDataBuffer();
  const item = {
    url: u,
    method: req.method(),
    headers: req.headers(),
    resourceType: req.resourceType(),
    postDataLength: postData.length,
    postDataBytes: postDataBuf?.length ?? null,
    postDataPreview: postData.slice(0, 200),
    postDataIsLikelyBase64: /^[A-Za-z0-9+/=_\-]+$/.test(postData.slice(0, 200)),
  };
  if (postDataBuf) {
    const slug = (u.split("/").pop() || "post").replace(/\?.*/, "");
    const fname = `${posts.length.toString().padStart(2, "0")}-${slug}.bin`;
    writeFileSync(join(OUT, "mitm-bodies", fname), postDataBuf);
    item.bodyDumpedTo = fname;
  }
  posts.push(item);
  console.log(`POST captured: ${u}  (${item.postDataBytes ?? "?"} bytes)`);
});

page.on("response", async (resp) => {
  if (resp.request().method() !== "POST") return;
  const u = resp.url();
  if (!(PX_PATH_RE.test(u) || PX_HOST_RE.test(u))) return;
  const last = posts[posts.length - 1];
  if (last && last.url === u && !last.responseStatus) {
    last.responseStatus = resp.status();
    last.responseHeaders = resp.headers();
    try {
      const body = await resp.body();
      last.responseLength = body.length;
      last.responsePreview = body.toString("utf8").slice(0, 200);
      const fname = `${(posts.length - 1).toString().padStart(2, "0")}-response.bin`;
      writeFileSync(join(OUT, "mitm-bodies", fname), body);
    } catch {}
  }
});

console.log(`mitm: loading ${TARGET}`);
const r = await page
  .goto(TARGET, { waitUntil: "load", timeout: 30000 })
  .catch((e) => ({ status: () => "err", _err: e.message }));
console.log(`  HTTP ${r.status?.() ?? "?"}  title="${await page.title()}"`);

async function wander() {
  const vp = page.viewportSize();
  if (!vp) return;
  for (let i = 0; i < 8; i++) {
    const x = 100 + Math.random() * (vp.width - 200);
    const y = 100 + Math.random() * (vp.height - 200);
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) });
    await page.waitForTimeout(200 + Math.random() * 400);
  }
}

async function scroll() {
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 200 + Math.random() * 300);
    await page.waitForTimeout(400 + Math.random() * 600);
  }
}

console.log("  wandering...");
await wander();
await scroll();
console.log("  idling...");
await page.waitForTimeout(5000);
await wander();
await page.waitForTimeout(5000);

console.log("  triggering unload beacon...");
await page.goto("about:blank", { waitUntil: "load", timeout: 10000 }).catch(() => {});
await page.waitForTimeout(2000);

console.log(`\ntotal POSTs captured: ${posts.length}`);
posts.forEach((p, i) => {
  console.log(
    `  [${i}] ${p.url}\n      ${p.postDataBytes}B body, content-type: ${p.headers["content-type"] || "(none)"}\n      preview: ${JSON.stringify(p.postDataPreview)}\n      response: HTTP ${p.responseStatus} (${p.responseLength ?? "?"}B)`,
  );
});

writeFileSync(join(OUT, "mitm.json"), JSON.stringify({ target: TARGET, posts }, null, 2));
await ctx.close();
console.log(`\n  artifacts → ${OUT}/mitm.json + mitm-bodies/`);
