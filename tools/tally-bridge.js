#!/usr/bin/env node
/* ============================================================
   THE TALLY BRIDGE — the program that runs on the shop's PC

   Shop Manager is in a data centre. Tally is on this machine. The data
   centre cannot reach in, so this reaches out: it holds a request open
   against Shop Manager, and whenever there is XML for Tally it posts that
   XML to Tally here on localhost and sends back whatever Tally said.

   EVERY CONNECTION IS OUTBOUND. Nothing is opened on the router, no port
   is forwarded, and Tally is never reachable from outside this machine.
   That matters more than it might sound: Tally's XML port has no password
   at all, so anything that can reach it can rewrite the shop's books.

   Run it, leave it running, and keep Tally open with the company loaded.
   Closing this window stops the sync; nothing is lost, bills just wait in
   the queue until it runs again.

   Usage:
     node tally-bridge.js
     node tally-bridge.js --server https://... --token XXX --tally-port 9000

   Settings are read from, in order: the command line, the environment,
   then tally-bridge.json beside this file.
   ============================================================ */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function readConfig() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--")
      ? argv[++i] : "true";
  }

  let file = {};
  const at = path.join(__dirname, "tally-bridge.json");
  try { file = JSON.parse(fs.readFileSync(at, "utf8")); } catch (e) { /* optional */ }

  const pick = (k, envName, dflt) =>
    args[k] || process.env[envName] || file[k] || dflt;

  return {
    server:    String(pick("server", "BRIDGE_SERVER", "")).replace(/\/+$/, ""),
    token:     String(pick("token", "BRIDGE_TOKEN", "")),
    tallyHost: String(pick("tally-host", "TALLY_HOST", "localhost")),
    tallyPort: Number(pick("tally-port", "TALLY_PORT", 9000)),
    quiet:     String(pick("quiet", "BRIDGE_QUIET", "")) === "true"
  };
}

const cfg = readConfig();

function say(...a) { if (!cfg.quiet) console.log(...a); }
function stamp() { return new Date().toTimeString().slice(0, 8); }

if (!cfg.server || !cfg.token) {
  console.error("");
  console.error("  The Tally Bridge needs to know two things:");
  console.error("");
  console.error("    --server   your Shop Manager address, e.g. https://yourshop.onrender.com");
  console.error("    --token    the bridge token from Tally Sync > Setup");
  console.error("");
  console.error("  Put them on the command line, or in tally-bridge.json beside this file:");
  console.error('    { "server": "https://yourshop.onrender.com", "token": "..." }');
  console.error("");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* talking to Shop Manager                                             */
/* ------------------------------------------------------------------ */

function callServer(method, route, body, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(cfg.server + route);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "x-bridge-token": cfg.token,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {})
      }
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => out += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, raw: out });
      });
    });
    req.on("error", e => resolve({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs || 40000, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* talking to Tally, here on this machine                              */
/* ------------------------------------------------------------------ */

function postToTally(xml) {
  return new Promise((resolve) => {
    const body = Buffer.from(xml, "utf8");
    const req = http.request({
      host: cfg.tallyHost, port: cfg.tallyPort, method: "POST", path: "/",
      headers: { "Content-Type": "text/xml;charset=utf-8", "Content-Length": body.length }
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => out += c);
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: out }));
    });
    req.on("error", (e) => resolve({
      ok: false, code: e.code || "ERR",
      /* The same words the app uses when Tally is closed, so a shop reads
         one explanation wherever it appears. */
      error: e.code === "ECONNREFUSED"
        ? `Nothing is listening at ${cfg.tallyHost}:${cfg.tallyPort}. Open Tally, ` +
          "and switch its connectivity on: F1 (Help) > Settings > Connectivity > " +
          "Client/Server configuration, 'TallyPrime acts as' set to Server (or Both)."
        : "Could not reach Tally: " + e.message
    }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ ok: false, code: "TIMEOUT",
                error: "Tally did not answer. It may be sitting on a dialog box." });
    });
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* the loop                                                            */
/* ------------------------------------------------------------------ */

let stopping = false;
let backoff = 0;          /* seconds; grows only while the server is unreachable */
let lastState = "";

function state(s) {
  if (s === lastState) return;
  lastState = s;
  say(`  ${stamp()}  ${s}`);
}

async function loop() {
  while (!stopping) {
    const r = await callServer("GET", "/api/tally-bridge/poll", null, 40000);

    if (r.status === 401 || r.status === 403) {
      console.error(`\n  ${stamp()}  ${(r.json && r.json.error) || "The server refused this token."}`);
      console.error("  Make a new token in Tally Sync > Setup and put it in tally-bridge.json.\n");
      process.exit(1);
    }

    if (r.status !== 200) {
      /* Unreachable is normal on a shop line. Wait a little longer each
         time, up to half a minute, rather than hammering. */
      backoff = Math.min(backoff ? backoff * 2 : 2, 30);
      state(`Shop Manager unreachable (${r.error || "HTTP " + r.status}) — trying again in ${backoff}s`);
      await new Promise(res => setTimeout(res, backoff * 1000));
      continue;
    }

    backoff = 0;
    const job = r.json && r.json.job;
    if (!job) { state("connected — waiting for something to send"); continue; }

    state("connected");
    const result = await postToTally(job.xml);
    say(`  ${stamp()}  sent ${job.xml.length} bytes to Tally — ` +
        (result.ok ? "Tally answered" : "FAILED: " + result.error));
    await callServer("POST", "/api/tally-bridge/reply", { jobId: job.jobId, ...result }, 30000);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  say("\n  stopping — telling Shop Manager the bridge is going down");
  await callServer("POST", "/api/tally-bridge/goodbye", {}, 5000);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

say("");
say("  TALLY BRIDGE");
say("  Shop Manager : " + cfg.server);
say("  Tally        : " + cfg.tallyHost + ":" + cfg.tallyPort);
say("  Keep this window open, and keep Tally open with the company loaded.");
say("  Press Ctrl+C to stop.");
say("");
loop();
