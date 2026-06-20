# human-attack-bot

Reverse-engineering harness for [HUMAN Security](https://www.humansecurity.com)
(formerly **PerimeterX**) bot detection — the first-party-proxied sensor
(`/{appId}/init.js`) as deployed on a major publisher, captured 2026-05-24.
Recovers the collector payload end-to-end: cracks the transport cipher,
deobfuscates the string table, and maps the hashed signal names — then
demonstrates that a clean residential/mobile network identity passes the
gate with an entirely honest fingerprint.

Companion writeup: **[HUMAN.md](HUMAN.md)** — full methodology, the XOR
transport reversed via common-prefix analysis, the base91 string table,
the hashed-signal-name dictionary, and the "clean IP beats the sensor"
result.

> **Scope.** Defensive / red-team research against PerimeterX's published
> client sensor on a public article page. Captures the sensor's own
> telemetry payload and reverses its encoding offline. Does not submit
> credentials, does not attempt to break into any account, does not
> exfiltrate user data. Intended audience: HUMAN's own research team, and
> anti-bot / fingerprinting practitioners studying production hardening.

---

## Quick start

```bash
git clone https://github.com/JWally/bots-human human-attack-bot
cd human-attack-bot
npm install                # installs playwright + downloads real Chrome channel
npm start                  # interactive menu — pick a script with arrow keys
```

`npm start` shows an arrow-key menu of all scripts with a description below
the highlighted item. The natural order of work, top to bottom:

```
human-attack-bot  —  HUMAN Security / PerimeterX reverse-engineering harness

❯ ★ bypass          — real Chrome + SOAX mobile + verdict heuristic (THE HEADLINER)
    recon           — find PX's first-party /{appId}/init.js sensor
    mitm            — capture the PX collector POST(s)
    cipher-probe    — crack the payload encoding (offline)
    decrypt         — decode every captured collector body (offline)
    decode-strings  — pull PX's base91 string table from the bundle
    build-dictionary— map 8-byte hashed signal names to meanings
    scan-strings    — keyword-scan the decoded string table
    diff            — diff two decrypted payload JSON files
    quit
```

Every script also has a direct npm shortcut (`npm run recon`,
`npm run decrypt`, …) and writes JSON to `results/` (gitignored).

### SOAX credentials

Only `bypass.mjs` needs a proxy. By default it reads `$HOME/Dev/soax.txt`
(one line per pool, format `POOL: curl -k -x USER:PASS@HOST:PORT -L URL`);
override with `SOAX_CONFIG=/path/to/creds.txt`. Any HTTP proxy with a
residential or mobile exit IP works — the gate is on TLS/JA4 + IP
reputation, not on which proxy vendor. Every other script is offline and
runs against the captured bundle/bodies already in `results/`.

---

## The pipeline

The sensor is PerimeterX's first-party model: the bundle is served from the
**publisher's own domain** at `/{appId}/init.js` and POSTs telemetry to
`/{appId}/xhr/...` (reverse-proxied to `collector-px{appId}.px-cloud.net`),
so third-party blockers never see PerimeterX at all. State lives in five
cookies (`_pxhd`, `_pxvid`, `_px2`, `pxcts`, `_pxde`).

### `bypass.mjs` ★ THE HEADLINER

Vanilla **real Chrome** (`channel: 'chrome'`, only
`--disable-blink-features=AutomationControlled`) through a SOAX
residential/mobile proxy, warm-up with humanlike mouse/scroll, then load a
PX-protected Bloomberg article. Captures every collector POST and reports a
verdict heuristic (HTTP status, `<title>`, presence of `#px-captcha`, body
length, PX cookie set). On a clean mobile identity: **HTTP 200, full
article, no captcha** — with a fully honest fingerprint payload. No sensor
tampering. The takeaway is that the expensive, obfuscated client sensor is
mostly evidence collection; the decisive gate is **IP reputation + a real
browser stack**.

### `recon.mjs`

Loads a target with real Chrome, logs every JS response, flags the
first-party `/{appId}/init.js` sensor, records the `appId`, dumps the bundle
to `results/bundle-{appId}-init.js`, and probes PX globals (`_pxAppId`,
`ClientUuid`) + cookies after load. Run first.

### `mitm.mjs`

Captures the collector POST(s) — every `payload=` body to the first-party
`/{appId}/xhr` proxy or `collector-px*.px-cloud.net` — and saves them raw to
`results/mitm-bodies/` + `results/mitm.json`. Optional in-flight bundle tap
for cleartext.

### `cipher-probe.mjs`

Reads `results/mitm.json`, base64-decodes each body, and runs
common-prefix + frequency + XOR-key trials. The 13 captured bodies share a
constant 7-byte ciphertext prefix; XOR-ing it yields `[{"t":"` — valid JSON.
Recovers the transport key (**single-byte XOR `0x32`**, no keying material,
no MAC) without ever patching the bundle.

### `decrypt.mjs`

XOR-`0x32` + base64-decode every captured collector body into the PX
telemetry array, written to `results/decrypted/*.json`:

```json
[{ "t": "<8-byte-base64 hash>", "d": { "<8-byte-base64 hash>": <value>, ... } }]
```

`t` and the `d` keys are 8-byte (64-bit) **hashed** signal names; values are
clear (numbers, strings, booleans, nested objects). Pure offline.

### `decode-strings.mjs`

The bundle ships an obfuscated string array (`ke=[...]`) and a **base91**
decoder (`kb`) with a permuted 91-char alphabet hardcoded at the top; a lazy
`kc(t)` returns `kb(ke[t])` on first read. This script extracts the alphabet
+ array and decodes every entry to `results/strings.json` (idx → plaintext),
recovering the API/property/endpoint strings the sensor hides.

### `build-dictionary.mjs`

The 8-byte hashed signal names are string literals at the call site where
each value is computed (`obj["InJQeGcTUEI="] = navigator.platform`, …). This
greps the bundle for each hash, reads a context window, and resolves what
each signal measures to `results/dictionary.json` (~75 of 189 recovered
structurally).

### `scan-strings.mjs` / `diff.mjs`

`scan-strings` keyword-scans `results/strings.json` for notable tokens.
`diff` compares two decrypted payload JSON files (counts, only-in-one,
changed values, verdict-relevant deltas) — e.g. a home-IP run vs a
SOAX-mobile run.

---

## Known limitations

- **PX rotates the sensor bundle.** The `appId` and bundle hash drift;
  re-run `recon.mjs` to grab the current bundle before the offline tools.
- **An inner blob layer remains.** XOR-`0x32` cleanly recovers the
  structural JSON and short scalar fields; some long fingerprint blobs go
  garbled after a prefix, implying a second inner encoding layered on those
  specific values. The harness is "good enough to index signal names," not a
  full plaintext recovery of every field.
- **The bypass uses a residential/mobile IP.** From a data-center or
  already-flagged IP you'll get an interactive `#px-captcha` or block. The
  harness reports the verdict; it does not solve the press-and-hold captcha
  — that's a different problem.
- **Real Chrome required.** `channel: 'chrome'`, not Chromium (downloaded
  via `postinstall`; otherwise `npx playwright install chrome`).
- **No credential submission.** The bypass demos navigation only.

## Companion documents

- **[HUMAN.md](HUMAN.md)** — the methodology + findings writeup.
- **[bots-x-castle](https://github.com/JWally/bots-x-castle)** and
  **[bots-datadome](https://github.com/JWally/bots-datadome)** — the same
  methodology applied to Castle and DataDome (different vendors, different
  ciphers, same chokepoint lessons).
