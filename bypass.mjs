#!/usr/bin/env node
/**
 * bypass.mjs — try to load a HUMAN/PX-protected article through SOAX mobile.
 *
 * Parallel to bots-datadome/bypass.mjs but adapted for PX:
 *   - No bundle patch needed (we already cracked the cipher offline).
 *   - Captures every PX collector POST so we can diff the signal payload
 *     between home-IP and SOAX-mobile verdicts.
 *   - Reports the verdict heuristic: HTTP status, page title, presence of
 *     #px-captcha, body length, PX cookie set.
 *
 * Usage: node bypass.mjs [target-url]
 *   default: a Bloomberg article (confirmed PX-protected)
 *
 * Env: SOAX_CONFIG (default ~/Dev/soax.txt)
 */

import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "results");
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "bypass-bodies"), { recursive: true });

const NO_PROXY = process.argv.includes("--no-proxy") || process.env.NO_PROXY === "1";

let PROXY = null;
if (!NO_PROXY) {
  const SOAX_PATH = process.env.SOAX_CONFIG || join(homedir(), "Dev", "soax.txt");
  if (!existsSync(SOAX_PATH)) {
    console.error(`[bypass] no SOAX config at ${SOAX_PATH}`);
    process.exit(1);
  }
  const SOAX = readFileSync(SOAX_PATH, "utf8");
  const mobileLine = SOAX.split("\n").find((l) => l.startsWith("MOBILE:"));
  if (!mobileLine) {
    console.error(`[bypass] no MOBILE: line in ${SOAX_PATH}`);
    process.exit(1);
  }
  const m = mobileLine.match(/-x (\S+):(\S+)@(\S+):(\d+)/);
  PROXY = {
    server: `http://${m[3]}:${m[4]}`,
    username: m[1],
    password: m[2],
  };
  console.log(`[soax] ${PROXY.server}  user=${PROXY.username.slice(0, 28)}…`);
} else {
  console.log(`[direct] no proxy — using local egress`);
}

const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
const TARGET =
  positional ||
  "https://www.bloomberg.com/news/articles/2026-05-23/deepseek-to-make-permanent-75-discount-on-flagship-ai-model";

const PX_PATH_RE = /\/[A-Za-z0-9_-]{6,12}\/(xhr|collect|b\/s|tt)(\?|$|\/)/;
const PX_HOST_RE = /\b(collector|tzm|captcha)[-A-Za-z0-9_]*\.px-(cloud|cdn|client|chk)\.net/;

async function wander(page, ms) {
  const end = Date.now() + ms;
  let x = 300 + Math.random() * 500,
    y = 300 + Math.random() * 300;
  while (Date.now() < end) {
    x = Math.max(50, Math.min(1300, x + (Math.random() - 0.5) * 80));
    y = Math.max(50, Math.min(800, y + (Math.random() - 0.5) * 60));
    await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 8) });
    await page.waitForTimeout(140 + Math.random() * 220);
  }
}
async function scroll(page, n) {
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, 200 + Math.random() * 400);
    await page.waitForTimeout(500 + Math.random() * 700);
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), "px-bypass-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
  viewport: { width: 1366, height: 900 },
  locale: "en-US",
  timezoneId: "America/Chicago",
  ...(PROXY ? { proxy: PROXY } : {}),
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
    bytes: postDataBuf?.length ?? null,
    preview: postData.slice(0, 100),
  };
  if (postDataBuf) {
    const fname = `${posts.length.toString().padStart(2, "0")}-collector.bin`;
    writeFileSync(join(OUT, "bypass-bodies", fname), postDataBuf);
    item.bodyDumpedTo = fname;
  }
  posts.push(item);
});

console.log("\nstep 0: smoke check exit IP");
let ipInfo = "";
try {
  await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
  ipInfo = await page.evaluate(() => document.body.innerText);
  console.log("  " + ipInfo.slice(0, 220));
} catch (e) {
  console.log("  ipinfo fetch failed: " + e.message);
}

console.log(`\nstep 1: navigate to article`);
console.log(`  ${TARGET}`);
let initialStatus = null;
let initialTitle = "";
try {
  const r = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45000 });
  initialStatus = r.status();
  initialTitle = await page.title();
  console.log(`  initial HTTP ${initialStatus}  title="${initialTitle.slice(0, 80)}"`);
} catch (e) {
  console.log(`  goto failed: ${e.message}`);
}

await wander(page, 2500);
await scroll(page, 4);
await wander(page, 1500);
await page.waitForTimeout(2000);

const finalTitle = await page.title();
const finalUrl = page.url();
const finalHtml = await page.content();
const bodyText = await page
  .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 4000))
  .catch(() => "");
const hasCaptcha = await page
  .evaluate(() => !!document.getElementById("px-captcha"))
  .catch(() => false);
const articleH1 = await page
  .evaluate(() => document.querySelector("h1")?.innerText || "")
  .catch(() => "");

const cookies = await ctx.cookies("https://www.bloomberg.com/");
const pxCookies = cookies.filter((c) => /^_?px/i.test(c.name) || c.name === "pxcts");

writeFileSync(join(OUT, "bypass-article.html"), finalHtml);
await page.screenshot({ path: join(OUT, "bypass-article.png"), fullPage: false });

// Verdict logic
let verdictLabel;
if (/are you a robot|robot/i.test(finalTitle) || hasCaptcha) {
  verdictLabel = "CHALLENGED (px-captcha shown)";
} else if (initialStatus === 403) {
  verdictLabel = "BLOCKED (HTTP 403)";
} else if (
  initialStatus === 200 &&
  articleH1 &&
  articleH1.length > 12 &&
  !/are you a robot/i.test(articleH1)
) {
  verdictLabel = "CLEAN (article loaded)";
} else if (initialStatus === 200) {
  verdictLabel = "AMBIGUOUS (HTTP 200 but no clear article)";
} else {
  verdictLabel = `UNKNOWN (HTTP ${initialStatus})`;
}

console.log("\n=== VERDICT ===");
console.log(`  exit IP:        ${ipInfo.match(/"ip":"([^"]+)"/)?.[1] || "?"}`);
console.log(`  carrier:        ${ipInfo.match(/"carrier":"([^"]+)"/)?.[1] || "?"}`);
console.log(`  country:        ${ipInfo.match(/"country":"([^"]+)"/)?.[1] || "?"}`);
console.log(`  city:           ${ipInfo.match(/"city":"([^"]+)"/)?.[1] || "?"}`);
console.log(`  initial HTTP:   ${initialStatus}`);
console.log(`  final URL:      ${finalUrl}`);
console.log(`  title:          ${finalTitle.slice(0, 80)}`);
console.log(`  h1:             ${articleH1.slice(0, 80)}`);
console.log(`  body size:      ${finalHtml.length} bytes`);
console.log(`  px-captcha:     ${hasCaptcha ? "PRESENT (challenged)" : "absent"}`);
console.log(`  px cookies:     ${pxCookies.map((c) => c.name).join(", ") || "(none)"}`);
console.log(`  collector POSTs: ${posts.length}`);
console.log(`  VERDICT:        ${verdictLabel}`);

const verdict = {
  target: TARGET,
  exitIp: ipInfo.match(/"ip":"([^"]+)"/)?.[1],
  carrier: ipInfo.match(/"carrier":"([^"]+)"/)?.[1],
  country: ipInfo.match(/"country":"([^"]+)"/)?.[1],
  city: ipInfo.match(/"city":"([^"]+)"/)?.[1],
  initialStatus,
  initialTitle,
  finalUrl,
  finalTitle,
  articleH1,
  bytes: finalHtml.length,
  hasCaptcha,
  pxCookies: pxCookies.map((c) => ({ name: c.name, value: c.value.slice(0, 80) + "…" })),
  collectorPostCount: posts.length,
  collectorPosts: posts,
  verdictLabel,
  bodyTextPreview: bodyText.slice(0, 500),
  capturedAt: new Date().toISOString(),
};
writeFileSync(join(OUT, "bypass.json"), JSON.stringify(verdict, null, 2));

await ctx.close();
console.log(`\n  artifacts → ${OUT}/bypass.json + bypass-article.{html,png} + bypass-bodies/`);
