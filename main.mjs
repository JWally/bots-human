#!/usr/bin/env node
// Interactive launcher for human-attack-bot.
// Arrow-key menu over all scripts; descriptions render below the list.
// Children inherit stdio so live output streams through.

import prompts from "prompts";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = [
  {
    file: "bypass.mjs",
    title: "★ bypass          — real Chrome + SOAX mobile + verdict heuristic (THE HEADLINER)",
    desc:
      "Reads SOAX mobile creds from ~/Dev/soax.txt (or $SOAX_CONFIG). " +
      "Launches vanilla real Chrome (channel: 'chrome') via the SOAX proxy, " +
      "warms reputation with humanlike mouse/scroll, then loads a PX-protected " +
      "Bloomberg article. Captures every PX collector POST and reports the " +
      "verdict heuristic: HTTP status, page title, presence of #px-captcha, " +
      "body length, PX cookie set. Expected on a clean mobile IP: HTTP 200, " +
      "full article, no captcha. ~2 min.",
  },
  {
    file: "recon.mjs",
    title: "  recon           — find PX's first-party /{appId}/init.js sensor",
    desc:
      "Loads a target URL with real Chrome, logs every JS response, flags the " +
      "first-party-proxied /{appId}/init.js sensor, records the appId, dumps " +
      "the bundle to results/, and probes for PX globals (_pxAppId, ClientUuid) " +
      "+ cookies (_pxhd / _pxvid / _px2 / pxcts) after load. Run first to " +
      "confirm the deployment and grab the bundle. ~1 min.",
  },
  {
    file: "mitm.mjs",
    title: "  mitm            — capture the PX collector POST(s)",
    desc:
      "Launches real Chrome, performs ~25s of humanlike activity, and captures " +
      "every POST to the first-party /{appId}/xhr proxy or collector-PX*." +
      "px-cloud.net. Saves the raw payload= bodies to results/mitm-bodies/ " +
      "and results/mitm.json. Optional in-flight bundle tap for cleartext. " +
      "~1 min.",
  },
  {
    file: "cipher-probe.mjs",
    title: "  cipher-probe    — crack the payload encoding (offline)",
    desc:
      "Reads results/mitm.json, base64-decodes each captured payload= body, " +
      "and runs common-prefix + frequency + XOR-key trials. Recovers the " +
      "single-byte XOR transport key (0x32) from the constant ciphertext " +
      "prefix — no bundle patch, no keying material, no MAC. ~3 sec.",
  },
  {
    file: "decrypt.mjs",
    title: "  decrypt         — decode every captured collector body (offline)",
    desc:
      "XOR-0x32 + base64-decode each captured collector POST into the PX " +
      "telemetry array: [{\"t\":\"<hash>\",\"d\":{\"<hash>\": value, ...}}]. " +
      "Writes results/decrypted/*.json. The t and d keys are 8-byte hashed " +
      "signal names; values are clear. Pure offline. ~5 sec.",
  },
  {
    file: "decode-strings.mjs",
    title: "  decode-strings  — pull PX's base91 string table from the bundle",
    desc:
      "Extracts the permuted 91-char alphabet + obfuscated string array (ke[]) " +
      "from init.js and runs the lazy base91 decoder (kb) over every entry. " +
      "Dumps results/strings.json (idx → plaintext). This deobfuscates the " +
      "API/property/endpoint strings the sensor hides. ~2 sec.",
  },
  {
    file: "build-dictionary.mjs",
    title: "  build-dictionary— map 8-byte hashed signal names to meanings",
    desc:
      "For each hashed signal name (e.g. \"AW1zJ0cBdhc=\"), grep the bundle for " +
      "its string-literal call site and read a window of context (the property " +
      "or kc()-resolved expression assigned to it) to recover what each signal " +
      "measures. Writes results/dictionary.json. ~5 sec.",
  },
  {
    file: "scan-strings.mjs",
    title: "  scan-strings    — keyword-scan the decoded string table",
    desc:
      "Scans results/strings.json for notable tokens (navigator/webdriver/" +
      "automation/canvas/webgl/etc.) to surface the interesting deobfuscated " +
      "strings quickly. Run after decode-strings. ~1 sec.",
  },
  {
    file: "diff.mjs",
    title: "  diff            — diff two decrypted payload JSON files",
    desc:
      "Pass two decrypted payload JSON files. Prints total signal counts, " +
      "signals present in only one, signals with different values, and a " +
      "verdict-relevant deltas section. Use to compare a home-IP run vs a " +
      "SOAX-mobile run, or A/B two network identities. ~5 sec.",
  },
];

const QUIT = { title: "  quit", value: "__quit__" };

function renderTitle() {
  return [
    "human-attack-bot  —  HUMAN Security / PerimeterX reverse-engineering harness",
    "See README.md for context · HUMAN.md for the full writeup",
    "",
  ].join("\n");
}

async function runOne(scriptFile, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(__dirname, scriptFile), ...(extraArgs || [])], {
      stdio: "inherit",
      cwd: __dirname,
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function menu() {
  console.log(renderTitle());
  while (true) {
    const choices = SCRIPTS.map((s) => ({
      title: s.title,
      value: s.file,
      description: s.desc,
    }));
    choices.push(QUIT);
    const { pick } = await prompts({
      type: "select",
      name: "pick",
      message: "pick a script",
      choices,
      hint: "arrow keys to navigate · enter to run · esc/ctrl-c to quit",
    });
    if (!pick || pick === "__quit__") {
      console.log("\nbye.");
      break;
    }
    const exit = await runOne(pick);
    console.log(`\n[${pick}] exited with code ${exit}.\n`);
  }
}

menu().catch((e) => {
  console.error(e);
  process.exit(1);
});
