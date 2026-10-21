/* ============================================================
   SLOW AND DROPPED CONNECTIONS — the app says what happened

   Before 21 Oct 2026 a request that never came back left the screen
   spinning for good, and a dropped connection said only "Failed to fetch".

   The real api() from public/js/app.js is lifted out and run here against
   a pretend network, so this is the shipped code, not a copy of it:
     - a slow answer shows "still working" after 8 s and still arrives
     - nothing is given up before 90 s — a sleeping free-tier server takes
       about 50 s to wake, and that must not read as a failure
     - a request that never answers is given up at 90 s, and a SAVE says
       to check whether it went through before trying again
     - a dropped connection, and being offline, say so in plain words

   Timers are run on a fake clock, so this takes a second, not 90.
   Run:  node test/connection-messages.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), vm = require("vm");
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};

const src = fs.readFileSync(path.join(__dirname, "..", "public/js/app.js"), "utf8");
const start = src.indexOf("const API_SLOW_MS");
const end = src.indexOf("\nfunction toast(", start);
const apiSrc = src.slice(start, src.lastIndexOf("\n}", src.indexOf("/* A steady banner", start)) + 2);
ok("(the api helper was found in app.js)", start > 0 && end > start && /async function api\(/.test(apiSrc));

/* A fake clock: timers fire when the test says time has passed. */
function harness() {
  let now = 0, id = 0; const timers = new Map(); const toasts = [];
  const ctx = {
    toasts, navigator: { onLine: true },
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: t => timers.delete(t),
    AbortController, DOMException, Error, Promise, JSON,
    toast: m => toasts.push(m), showLogin: () => {},
    fetch: null,
    advance: async ms => {
      now += ms;
      for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(k); t.fn(); await Promise.resolve(); }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(apiSrc + "\nthis.api = api;", ctx);
  return ctx;
}
const reply = (status, body) => ({ status, ok: status < 400, headers: { get: () => "application/json" }, json: async () => body });
const settle = p => p.then(v => ({ v }), e => ({ e }));

(async () => {
  console.log("\n--- a slow answer ---\n");
  {
    const h = harness(); let answer;
    h.fetch = () => new Promise(r => { answer = r; });
    const p = settle(h.api("GET", "/customers"));
    await h.advance(7000);
    ok("no notice before 8 seconds", h.toasts.length === 0, h.toasts);
    await h.advance(1500);
    ok("\"still working\" after 8 seconds", /Still working — the connection is slow/.test(h.toasts[0] || ""), h.toasts);
    await h.advance(50000);
    answer(reply(200, [{ name: "A" }]));
    const r = await p;
    ok("a 58-second answer (a server waking up) still arrives — not given up", r.v && r.v[0].name === "A", r.e && r.e.message);
  }

  console.log("\n--- no answer at all ---\n");
  {
    const h = harness();
    h.fetch = (u, o) => new Promise((_, rej) => { o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
    const save = settle(h.api("POST", "/invoices", { x: 1 }));
    await h.advance(89000);
    let early = await Promise.race([save, Promise.resolve("pending")]);
    ok("still waiting at 89 seconds", early === "pending");
    await h.advance(2000);
    const r = await save;
    ok("given up at 90 seconds", r.e && r.e.timedOut === true, r.e && r.e.message);
    ok("...and a SAVE says to check whether it went through", /may or may not have been saved — check before trying again/.test(r.e && r.e.message), r.e && r.e.message);
    const h2 = harness();
    h2.fetch = (u, o) => new Promise((_, rej) => { o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
    const read = settle(h2.api("GET", "/customers"));
    await h2.advance(91000);
    const r2 = await read;
    ok("a READ that times out says to check the connection", /didn't answer in time\. Check your internet connection/.test(r2.e && r2.e.message), r2.e && r2.e.message);
  }

  console.log("\n--- a dropped connection, and being offline ---\n");
  {
    const h = harness();
    h.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const r = await settle(h.api("POST", "/customers", {}));
    ok("a dropped connection no longer says \"Failed to fetch\"", r.e && !/Failed to fetch/.test(r.e.message) && /Couldn't reach the server/.test(r.e.message), r.e && r.e.message);
    ok("...and is marked as a network problem", r.e && r.e.network === true);
    h.navigator.onLine = false;
    const r2 = await settle(h.api("POST", "/customers", {}));
    ok("offline, a save says it was NOT saved", /You're offline, so this was not saved/.test(r2.e && r2.e.message), r2.e && r2.e.message);
  }

  console.log("\n--- ordinary answers are unchanged ---\n");
  {
    const h = harness();
    h.fetch = async () => reply(403, { error: "You don't have permission.", permission: true });
    const r = await settle(h.api("GET", "/bank-accounts"));
    ok("a refusal still comes back as the server's own words", r.e && r.e.message === "You don't have permission." && r.e.status === 403 && r.e.permission === true, r.e);
    h.fetch = async () => reply(200, { ok: true });
    ok("a normal answer is returned as before", (await h.api("GET", "/health")).ok === true);
    ok("...with no notice shown", h.toasts.length === 0, h.toasts);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
