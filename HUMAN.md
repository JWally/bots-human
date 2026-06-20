# HUMAN Security / PerimeterX — reverse-engineering writeup

Target: the **HUMAN Bot Defender** (formerly PerimeterX) sensor as deployed
first-party on a major publisher (Bloomberg), `appId` `8FCGYgk4`, captured
2026-05-24. All findings are reproducible offline from the bundle + collector
bodies in `results/`.

---

## 1. Deployment model — first-party proxied sensor

PerimeterX runs in **first-party** mode: the sensor is served from the
publisher's own origin, not a third-party PX domain.

- Bundle: `https://www.bloomberg.com/8FCGYgk4/init.js`
- Telemetry: `POST https://www.bloomberg.com/8FCGYgk4/xhr/api/v2/collector`,
  reverse-proxied to `collector-px8fcgygk4.px-cloud.net/api/v2/collector`.
- In-page globals: `_pxAppId: "PX8FCGYgk4"`, a `PX8FCGYgk4` config object
  carrying `ClientUuid`, plus `_pxParam3/4/6`.
- State machine in five cookies: `_pxhd` (hard token), `_pxvid` (visitor id),
  `_px2`/`_px3` (verdict token), `pxcts` (timestamp), `_pxde` (data
  enrichment, embeds base64 JSON).

Because both the script and its telemetry ride the customer's domain,
third-party blockers and cookie defenses never see PerimeterX at all. This is
the single biggest architectural difference from DataDome (`js.datadome.co`)
and FingerprintJS, which more often load third-party.

## 2. Wire format

The POST body is `payload=<urlencoded-base64>`. After base64-decode and
decipher (§3) it is a JSON array of telemetry batches:

```json
[{ "t": "<8-byte-base64 hash>", "d": { "<8-byte-base64 hash>": <value>, ... } }, ...]
```

`t` is a batch/event-type tag; the `d` keys are **8-byte (64-bit) hashed
signal names** (e.g. `"AW1zJ0cBdhc="`, `"InJQeGcTUEI="`) — not human-readable.
~189 unique hashed names were observed across 13 captures. Values are clear:
numbers, strings, UUIDs, nested objects. Internal probe IDs surface raw as
`PX####` numeric sub-keys inside value objects (e.g. `{"PX12737":5}`).

## 3. Three layers of protection — each defeated offline

### 3.1 Transport cipher — single-byte XOR `0x32`

No keying material, no MAC. Recovered by **common-prefix analysis**
(`cipher-probe.mjs`): the 13 captured bodies share a constant 7-byte prefix
(`69 49 10 46 10 08 10` hex). A printable-ratio XOR sweep ranks `0x32`
top, and XOR-`0x32` of the prefix yields `[{"t":"` — valid JSON.
`decrypt.mjs` then decodes every body to `results/decrypted/*.json`.

**Caveat — an inner layer remains.** XOR-`0x32` cleanly recovers the
structural JSON and short scalar fields, but some long fingerprint blobs go
garbled after a prefix, strongly implying a second inner encoding layered on
those specific values. This harness indexes the signal *names* and most
scalar values; it is not a full plaintext recovery of every blob.

### 3.2 String obfuscation — base91 + lazy decoder

The bundle ships a permuted **91-character alphabet** inside `kb()` and an
obfuscated string array `ke=[...]`; `kc(t)` lazily returns `kb(ke[t])` on
first read. `kb()` is a textbook base91 decoder (the `i + 91*c`, 13/14-bit
accumulator). `decode-strings.mjs` extracts the alphabet + array and decodes
all entries to `results/strings.json` — recovering the hidden API/property/
endpoint strings (`navigator`, `userAgent`, the collector path, …). The
extracted alphabet (this capture) is 91 chars beginning `uGsyV!r(ZajH3{…`,
with 1180 string entries. (Note: PX uses base91 here, *not* base64 — a useful
cross-vendor tell.)

### 3.3 Hashed signal names — structural recovery

Even after decrypt + string-decode, the `d` keys stay opaque 8-byte hashes.
`build-dictionary.mjs` reverses them *structurally*: each hash is a string
literal at the call site where its value is computed
(`n["AW1zJ0cBdhc="]=…`, `o.d["AhIwWEd1PWo="]=(new Date).getTime()`), so a
±200-byte context window plus the resolved `kc()` strings recovers meaning
for ~**75 of 189** names.

## 4. Signals collected

From the decoded payloads + dictionary: navigator (UA, platform,
`hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `webdriver`),
screen/viewport, canvas / WebGL / AudioContext fingerprints, behavioral
(mouse / touch / keydown / pointer + MutationObserver), CDP/automation tells
(`cdc_`, `automationControlled`, `HeadlessChrome`, phantom/selenium), workers
/ iframes, storage, and `connection`/`effectiveType`/`rtt`. One field even
captures a live JS exception **stack trace** — which both exposes
VM-internal frames and lets PX detect co-resident scripts (it caught a
reCAPTCHA `recaptcha__en.js` frame in the same trace).

## 5. The bypass result — clean IP beats the sensor

`bypass.mjs`: vanilla **real Chrome** (`channel: 'chrome'`,
`--disable-blink-features=AutomationControlled`) + humanlike mouse/scroll,
through a SOAX residential/mobile exit, loading the PX-protected article.
Result: **HTTP 200, full article, no `#px-captcha`** — emitting a fully
*honest* ~189-signal payload that openly includes automation-adjacent fields.
We never tampered with the sensor; we recorded the genuine payload and let it
pass.

The lesson: PerimeterX's strongest signal is the **network identity**, not
the browser fingerprint, and the two are gated independently. The expensive,
heavily-obfuscated client sensor (base91 strings, hashed names, XOR
transport, inner blob layer) is mostly evidence collection for the
server-side risk model; the decisive, cheap gate is **IP reputation +
TLS/JA4 + a plausible real-browser stack**. The defender's corollary: if a
verdict can be won with an honest fingerprint over a clean IP, the
client-side obfuscation is theater — you must score the *network identity*
and demand *positive* proof-of-humanity, because a stealthed real browser
behind mobile is byte-identical to a human.

## 6. Tooling

| Script | Role |
|---|---|
| `recon.mjs` | find the first-party `/{appId}/init.js` sensor, dump the bundle, read PX globals/cookies |
| `mitm.mjs` | capture the collector `payload=` bodies |
| `cipher-probe.mjs` | recover the XOR-`0x32` transport key via common-prefix analysis |
| `decrypt.mjs` | XOR + base64-decode every body into the telemetry array |
| `decode-strings.mjs` | extract + base91-decode the bundle string table |
| `build-dictionary.mjs` | map 8-byte hashed signal names to meanings |
| `scan-strings.mjs` | keyword-scan the decoded strings |
| `bypass.mjs` | the live clean-IP bypass + verdict heuristic |
| `diff.mjs` | diff two decrypted payloads |

## 7. Unique mechanisms vs other vendors

- **First-party proxied sensor** (`/{appId}/init.js` + `/{appId}/xhr`) on the
  customer's domain — DataDome/FPJS more often load third-party.
- **Five-cookie state machine** vs DataDome's single signed-envelope model.
- **64-bit hashed signal names** as object keys (DataDome ships plaintext
  prefixed names like `nt_`, `m_`, `k_`).
- **base91** string-array obfuscation + **XOR-`0x32` + an inner blob layer**,
  rather than DataDome's PRNG keystream over a custom base64 alphabet.
- **Stack-trace exfiltration** as a dedicated signal.
