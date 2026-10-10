/* ============================================================
   PRIVACY — the controls, and whether the policy tells the truth

   Two halves.

   The controls: a garbled request must not write the PIN in it into the
   host's logs; the Assistant must not send phone numbers to Google; the
   policy pages must be reachable before anyone signs in.

   And the policy pages, read against the CODE. A privacy policy that says
   "30 days" while the cookie lasts 60 is a false statement to the people
   it is meant to protect, and it goes wrong silently — somebody changes a
   constant and nobody thinks of the page. So every number and every
   service the pages name that the code can confirm is checked here, from
   the source, and this fails the moment the two drift apart.

   Isolated data only: a temp directory and invented records.

   Run:  node test/privacy.test.js
   ============================================================ */
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.ASSISTANT_API_KEY;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = p => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const PAGES = ["index", "privacy", "terms", "retention", "ai", "contact"];
const page = n => read(`public/legal/${n}.html`);

(async () => {
  /* ---------------------------------------------------------------- */
  console.log("\n--- what an error may say in a log ---\n");
  {
    const { describeError, scrubMessage } = require(path.join(ROOT, "server/logSafe.js"));
    const e = new SyntaxError(`Unexpected token 'x', "{"pin":"4821","phone":"9820012345"" is not valid JSON`);
    e.body = '{"staffId":"STAFF_owner","pin":"4821"}';
    e.type = "entity.parse.failed";
    e.status = 400;
    const d = JSON.stringify(describeError(e));
    ok("the raw request body is never in the description", !/STAFF_owner|"pin"/.test(d), d);
    ok("...nor the PIN, even from inside the message", !/4821/.test(d), d);
    ok("...nor a phone number", !/9820012345/.test(d), d);
    ok("...but the kind of fault survives", /entity\.parse\.failed/.test(d) && /SyntaxError/.test(d), d);
    ok("long digit runs are masked", scrubMessage("account 50100234567 failed") === "account # failed");
    ok("quoted values are masked", scrubMessage(`no such row: "Ramesh Traders"`) === 'no such row: "…"');
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- a garbled sign-in, sent to the real server ---\n");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-srv-"));
    const p = spawn(process.execPath, ["--no-warnings", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, PORT: "4880",
             SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" },
    });
    let out = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => out += d);
    for (let i = 0; i < 120 && !/running on port 4880/.test(out); i++) await new Promise(r => setTimeout(r, 250));
    ok("the server starts", /running on port 4880/.test(out), out.slice(-300));

    const r = await fetch("http://127.0.0.1:4880/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"staffId":"STAFF_owner","pin":"4821","note":"call 9820012345"',   // not valid JSON
    });
    const body = await r.text();
    await new Promise(res => setTimeout(res, 600));
    ok("it is refused as the caller's mistake (400), not a server fault", r.status === 400, r.status);
    ok("...with a plain message", /not readable/i.test(body), body);
    ok("THE PIN DOES NOT REACH THE SERVER'S LOG", !/4821/.test(out), out.slice(-400));
    ok("...nor the phone number in it", !/9820012345/.test(out));
    ok("...but the fault IS logged, so it can be found", /\[error\] POST \/api\/auth\/login/.test(out), out.slice(-300));

    /* The pages, from the same server, with no session at all. */
    for (const n of PAGES) {
      const res = await fetch(`http://127.0.0.1:4880/legal/${n === "index" ? "" : n + ".html"}`);
      ok(`/legal/${n === "index" ? "" : n + ".html"} is readable without signing in`, res.status === 200, res.status);
    }
    p.kill();
    await new Promise(res => setTimeout(res, 500));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the pages themselves ---\n");
  for (const n of PAGES) {
    const h = page(n);
    ok(`${n}: works on a phone (viewport)`, /name="viewport"/.test(h));
    ok(`${n}: links to every other policy`,
       PAGES.filter(x => x !== "index").every(x => h.includes(`/legal/${x}.html`)));
    ok(`${n}: says it is a draft until the operator finishes it`, /Draft — not yet in force/.test(h));
    ok(`${n}: does not name the vendor's own shop (it ships to buyers)`, !/swagat/i.test(h));
    ok(`${n}: does not claim to make anyone compliant`, !/(fully|guarantee[sd]?) compliant|certified/i.test(h));
  }
  ok("the sign-in screen links to the policies", /href="\/legal\/privacy\.html"/.test(read("public/index.html")));

  /* ---------------------------------------------------------------- */
  console.log("\n--- THE POLICY MATCHES THE CODE ---\n");
  {
    const priv = page("privacy"), ret = page("retention"), ai = page("ai");

    /* trackers */
    const anyTracker = /google-analytics|gtag\(|googletagmanager|mixpanel|segment\.io|hotjar|clarity\.ms|facebook\.net|sentry/i;
    const front = read("public/index.html") + read("public/js/app.js");
    ok("the app contains no analytics or tracker", !anyTracker.test(front + code("server/index.js")));
    ok("...and the policy says so", /no advertising and no analytics or tracking/i.test(priv));
    ok("scripts can only come from the app itself (so nothing can be added unseen)",
       /script-src 'self'/.test(read("server/index.js")));

    /* the cookie */
    const idx = read("server/index.js");
    ok("the session cookie lasts 30 days in the code",
       /maxAge:\s*1000\s*\*\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*30/.test(idx));
    ok("...and 30 days in the policy", /up to 30 days/.test(priv) && /Up to 30 days/.test(ret));
    ok("...and it cannot be read by page scripts, as the policy says",
       /httpOnly:\s*true/.test(idx) && /cannot be read by scripts/.test(priv));

    /* backups */
    const bk = read("server/backup.js");
    const keepLocal = (/const KEEP_LOCAL = (\d+)/.exec(bk) || [])[1];
    const keepCloud = (/const KEEP_CLOUD = (\d+)/.exec(bk) || [])[1];
    ok(`local backups kept: ${keepLocal} in the code, the same in the policy`,
       keepLocal && ret.includes(`most recent ${keepLocal}<`), keepLocal);
    ok(`off-site backups kept: ${keepCloud} in the code, the same in the policy`,
       keepCloud && ret.includes(`most recent ${keepCloud} runs`), keepCloud);
    ok("payment attachments really are copied to the backup store, as the policy says",
       /uploadToCloud\(/.test(code("server/attachments.js")) && /also copied to off-site backup/.test(ret));

    /* AI */
    const tools = read("server/assistant/tools.js");
    const maxRows = (/const MAX_ROWS = (\d+)/.exec(tools) || [])[1];
    ok(`the Assistant sends at most ${maxRows} records, as the AI page says`,
       maxRows && ai.includes(`at most ${maxRows}`), maxRows);
    const rl = /bucket:\s*"assistant",\s*max:\s*(\d+)/.exec(idx);
    ok("the Assistant's rate limit matches the AI page",
       rl && ai.includes(`at most ${rl[1]} questions a minute`), rl && rl[1]);
    ok("the service the code calls for AI is the one the pages name",
       /generativelanguage\.googleapis\.com/.test(read("server/assistant/provider.js")) && /Gemini API/.test(ai) && /Gemini API/.test(priv));

    /* every outside service the code can reach is named */
    const cs = read("server/cloudStore.js");
    ok("Cloudflare R2 is used for backups and named", /r2\.cloudflarestorage\.com/.test(cs) && /Cloudflare R2/.test(priv));
    ok("Supabase Storage is used for backups and named", /storage\/v1\/object/.test(cs) && /Supabase Storage/.test(priv));
    ok("e-way bills go to a GST provider, and that is named", /fetch\(/.test(code("server/ewb/nic.js")) && /GST Suvidha Provider/.test(priv));
    ok("WhatsApp is only ever a link the user taps, as the policy says",
       !/graph\.facebook\.com|api\.whatsapp\.com/.test(code("server/routes/whatsapp.js")) && /does not send WhatsApp messages itself/.test(priv));
    ok("the licence check-in exists and is named",
       /LICENCE_SERVER/.test(read("server/licenseCheckin.js")) && /licence server/i.test(priv));

    /* deletion */
    ok("customers with transactions really cannot be deleted",
       /customerUsage\(c\.id\)\.total > 0/.test(read("server/routes/customers.js")));
    ok("...nor suppliers", /supplierUsage\(s\.id\)\.total > 0/.test(read("server/routes/suppliers.js")));
    ok("...and a deleted product's past bill lines keep their name, as the policy says",
       /invoice_items SET product_id = NULL/.test(read("server/routes/products.js")) &&
       /name TEXT NOT NULL/.test(read("server/db-schema.js")) && /past bills keep the\s+product’s description/.test(ret));
    ok("the activity log really is append-only, as the policy warns",
       /audit_log is append-only/.test(read("server/db-schema.js")) && /cannot be edited or\s+deleted/.test(ret));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the Assistant sends no phone numbers ---\n");
  {
    const db = require(path.join(ROOT, "server/db.js"));
    const tools = require(path.join(ROOT, "server/assistant/tools.js"));
    const owner = { session: { loggedIn: true, role: "owner", staffId: "STAFF_owner" } };
    const c = db.companies.list()[0];
    db.companies.runAs(c.id, () => {
      db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES ('C1','Invented Traders','9000000001',500,?,1)").run(Date.now());
      const s = tools.run(owner, "search_customers", { query: "Invented" });
      ok("a customer search finds them", s.ok && s.data.matched === 1, s);
      ok("...WITHOUT their phone number", s.ok && !JSON.stringify(s.data).includes("9000000001"), s.data);
      const byPhone = tools.run(owner, "search_customers", { query: "9000000001" });
      ok("searching BY phone still works", byPhone.ok && byPhone.data.matched === 1, byPhone);
      ok("...and still does not send the number back", !JSON.stringify(byPhone.data).includes("9000000001"));
      const owes = tools.run(owner, "customer_outstanding", {});
      ok("'who owes money' finds them", owes.ok && owes.data.matched === 1, owes);
      ok("...WITHOUT their phone number", !JSON.stringify(owes.data).includes("9000000001"), owes.data);
    });
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- telling people where their data goes ---\n");
  {
    const app = read("public/js/app.js");
    ok("the Assistant says, where questions are typed, that they go to Google",
       /are sent to Google to write the answer/.test(app));
    ok("...and links to how it works", /href="\/legal\/ai\.html"/.test(app));
    ok("the AI key box warns about Google's free tier", /billing turned on/.test(app) && /free tier/.test(app));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the operator's notes match ---\n");
  {
    const doc = read("PRIVACY-COMPLIANCE.md");
    ok("the compliance notes exist", doc.length > 2000);
    ok("...give the verified DPDP dates", /13 Nov 2025/.test(doc) && /13 May 2027/.test(doc));
    ok("...list what the operator must supply", /\[PRIVACY EMAIL\]/.test(doc) && /\[GRIEVANCE OFFICER NAME\]/.test(doc));
    ok("...and what needs a lawyer", /For a qualified lawyer/.test(doc));
    const placeholders = PAGES.flatMap(n => page(n).match(/\[[A-Z][A-Z ,.()0-9-]+\]/g) || []);
    const unique = [...new Set(placeholders.map(p => p.replace(/, e\.g\..*\]/, "]")))];
    const listed = unique.filter(p => !doc.includes(p.split(",")[0].replace(/\]$/, "")));
    ok("every placeholder on the pages is listed for the operator to fill", listed.length === 0, listed);
  }

  console.log(`\n==============================================`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`==============================================\n`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error("\nTEST ERROR: " + e.stack); process.exitCode = 1; });
