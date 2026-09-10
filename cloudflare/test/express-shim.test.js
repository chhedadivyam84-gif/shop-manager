/* Proves the Express shim behaves like Express for the surface the 58
   route files actually use. Runs in plain Node — no Workers runtime
   needed, because routing and parameter extraction are pure logic. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const express = require("../src/express-shim.cjs");
const { Res } = express;

let pass = 0, fail = 0;
const ok = (l, c, x) => {
  if (c) { pass++; console.log(`  ok    ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${x !== undefined ? "   -> " + x : ""}`); }
};

function mkReq(method, path, { body, query } = {}) {
  return { method, path, body: body || {}, query: query || {}, params: {}, session: {}, ip: "1.2.3.4" };
}
async function run(router, method, path, opts) {
  const req = mkReq(method, path, opts);
  const res = new Res();
  const handled = await router.handle(req, res, path);
  return { handled, res, req };
}

console.log("\nROUTING");
{
  const r = express.Router();
  r.get("/", (req, res) => res.json({ hit: "root" }));
  r.get("/settings", (req, res) => res.json({ hit: "settings" }));
  r.get("/:id", (req, res) => res.json({ hit: "byId", id: req.params.id }));
  r.get("/:id/items", (req, res) => res.json({ hit: "items", id: req.params.id }));
  r.post("/", (req, res) => res.status(201).json({ hit: "created" }));

  ok("root path", JSON.parse((await run(r, "GET", "/")).res.body).hit === "root");
  ok("literal beats param when declared first",
     JSON.parse((await run(r, "GET", "/settings")).res.body).hit === "settings");

  const byId = await run(r, "GET", "/P_123");
  ok("captures :id", JSON.parse(byId.res.body).id === "P_123", byId.res.body);

  const items = await run(r, "GET", "/P_9/items");
  ok("captures :id with a trailing segment", JSON.parse(items.res.body).id === "P_9");

  const made = await run(r, "POST", "/");
  ok("method is respected", JSON.parse(made.res.body).hit === "created");
  ok("status code carries", made.res.statusCode === 201, made.res.statusCode);

  const miss = await run(r, "GET", "/a/b/c/d");
  ok("unmatched path is not handled", miss.handled === false);

  const wrongMethod = await run(r, "DELETE", "/settings");
  ok("wrong method does not match", wrongMethod.handled === false);
}

console.log("\nPARAMS ARE DECODED");
{
  const r = express.Router();
  r.get("/:name", (req, res) => res.json({ name: req.params.name }));
  const got = await run(r, "GET", "/" + encodeURIComponent("SAMARTH PLY 710"));
  ok("percent-encoding is decoded", JSON.parse(got.res.body).name === "SAMARTH PLY 710",
     got.res.body);
}

console.log("\nBODY, QUERY, SESSION, IP");
{
  const r = express.Router();
  r.post("/x", (req, res) => res.json({
    body: req.body, q: req.query.from, ip: req.ip, who: req.session.staffName,
  }));
  const req = mkReq("POST", "/x", { body: { total: 1250.5 }, query: { from: "2026-04-01" } });
  req.session.staffName = "Owner";
  const res = new Res();
  await r.handle(req, res, "/x");
  const out = JSON.parse(res.body);
  ok("body arrives", out.body.total === 1250.5, JSON.stringify(out.body));
  ok("query arrives", out.q === "2026-04-01", out.q);
  ok("ip arrives", out.ip === "1.2.3.4", out.ip);
  ok("session arrives", out.who === "Owner", out.who);
}

console.log("\nMIDDLEWARE AND next()");
{
  const order = [];
  const r = express.Router();
  r.get("/g", (req, res, next) => { order.push("mw1"); next(); },
             (req, res, next) => { order.push("mw2"); next(); },
             (req, res) => { order.push("handler"); res.json({ ok: true }); });
  const out = await run(r, "GET", "/g");
  ok("middleware chain runs in order", order.join(">") === "mw1>mw2>handler", order.join(">"));
  ok("final handler responds", out.res.finished === true);
}

console.log("\nMIDDLEWARE THAT REFUSES (the permission guards)");
{
  const r = express.Router();
  const requireOwner = (req, res, next) => {
    if (req.session.role !== "owner") return res.status(403).json({ error: "Only the shop owner can do this." });
    next();
  };
  r.delete("/:id", requireOwner, (req, res) => res.json({ deleted: req.params.id }));

  const asStaff = mkReq("DELETE", "/7"); asStaff.session.role = "staff";
  const res1 = new Res();
  await r.handle(asStaff, res1, "/7");
  ok("guard blocks with 403", res1.statusCode === 403, res1.statusCode);
  ok("and the handler never ran", !String(res1.body).includes("deleted"), res1.body);

  const asOwner = mkReq("DELETE", "/7"); asOwner.session.role = "owner";
  const res2 = new Res();
  await r.handle(asOwner, res2, "/7");
  ok("owner passes the guard", JSON.parse(res2.body).deleted === "7", res2.body);
}

console.log("\nASYNC HANDLERS");
{
  const r = express.Router();
  r.get("/slow", async (req, res) => {
    await new Promise((s) => setTimeout(s, 5));
    res.json({ done: true });
  });
  const out = await run(r, "GET", "/slow");
  ok("async handler is awaited", JSON.parse(out.res.body).done === true, out.res.body);
}

console.log("\nNESTED ROUTERS (router.use)");
{
  const child = express.Router();
  child.get("/deep", (req, res) => res.json({ where: "child" }));
  const parent = express.Router();
  parent.use("/sub", child);
  const out = await run(parent, "GET", "/sub/deep");
  ok("mounted router is reached", JSON.parse(out.res.body).where === "child", out.res.body);
}

console.log("\nRESPONSE SHAPES");
{
  const r = express.Router();
  r.get("/j", (req, res) => res.json({ a: 1 }));
  r.get("/s", (req, res) => res.send("plain"));
  r.get("/h", (req, res) => { res.setHeader("X-Thing", "yes"); res.json({}); });

  const j = await run(r, "GET", "/j");
  ok("json sets content-type", j.res.headers["content-type"].includes("application/json"));
  const s = await run(r, "GET", "/s");
  ok("send returns the string", s.res.body === "plain", s.res.body);
  const h = await run(r, "GET", "/h");
  ok("setHeader survives", h.res.headers["x-thing"] === "yes", JSON.stringify(h.res.headers));

  const resp = j.res.toResponse();
  ok("converts to a real Response", resp instanceof Response && resp.status === 200);
}

console.log("\nUNSUPPORTED THINGS FAIL LOUDLY");
{
  let threw = false;
  try { express.Router().get("/a/*/b", () => {}); } catch { threw = true; }
  ok("a wildcard pattern is rejected at registration", threw);

  const res = new Res();
  let threw2 = false;
  try { res.sendFile("/x"); } catch { threw2 = true; }
  ok("sendFile explains itself instead of returning nothing", threw2);
}

console.log(`\n${fail ? fail + " CHECK(S) FAILED" : "ALL " + pass + " CHECKS PASSED"}\n`);
process.exitCode = fail ? 1 : 0;
