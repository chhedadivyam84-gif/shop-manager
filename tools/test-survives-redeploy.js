/* One application, many shops, and nothing lost.

   Three failures are reproduced here, all of which would have cost a
   customer their books:

     1. a redeploy wipes the disk — everything must come back, INCLUDING
        the map from a login to whose books are whose
     2. that map is lost anyway — the app must still find the right books
        rather than making a new empty company
     3. a demo is converted to paid — the shop must not be locked out on
        the day their old demo date passes
*/
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const { spawn } = require("child_process");
const APP = "C:/Users/prafu/shop-manager";
const LIC = "C:/Users/prafu/shop-manager-licence";
const KEYS = "C:/Users/prafu/shop-manager-vendor-keys";
const APP_PORT = 4504, PANEL_PORT = 4505, STORE_PORT = 4506, PW = "survive-test-password";

let fails = 0;
const check = (w, g, e) => {
  const ok = JSON.stringify(g) === JSON.stringify(e);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${w}` + (ok ? "" : `\n          got  ${JSON.stringify(g)}\n          want ${JSON.stringify(e)}`));
};

/* ---- a Supabase-shaped store the app backs up into ---- */
const buckets = new Map([["shop-backups", {}]]);
const objects = new Map();
const ss = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/storage/v1/bucket" && req.method === "POST") { let b=""; req.on("data",c=>b+=c);
    req.on("end",()=>{ buckets.set(JSON.parse(b||"{}").name,{}); res.writeHead(200); res.end("{}"); }); return; }
  if (url === "/storage/v1/bucket" && req.method === "GET") {
    res.writeHead(200); res.end(JSON.stringify([...buckets.keys()].map(n=>({name:n,id:n})))); return; }
  const list = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url);
  if (list) { const b=list[1];
    const names=[...objects.keys()].filter(k=>k.startsWith(b+"/")).map(k=>({name:k.slice(b.length+1)}));
    res.writeHead(200,{ "content-type":"application/json" }); res.end(JSON.stringify(names)); return; }
  const m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url);
  if (m) { const [,b,name]=m;
    if (!buckets.has(b)) { res.writeHead(400); res.end(JSON.stringify({error:"Bucket not found",code:"NoSuchBucket"})); return; }
    if (req.method==="POST"){ const cs=[]; req.on("data",c=>cs.push(c));
      req.on("end",()=>{ objects.set(b+"/"+name, Buffer.concat(cs)); res.writeHead(200); res.end("{}"); }); return; }
    if (req.method==="GET"){ const buf=objects.get(b+"/"+name);
      if(!buf){res.writeHead(404);res.end("no");return;} res.writeHead(200); res.end(buf); return; }
    if (req.method==="DELETE"){ objects.delete(b+"/"+name); res.writeHead(200); res.end("{}"); return; }
  }
  res.writeHead(200); res.end("{}");
});

const jar = { A:"", B:"", V:"" };
const req_ = (who, port, m, p, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const h = { "content-type": "application/json" };
  if (jar[who]) h.cookie = jar[who];
  if (data) h["content-length"] = Buffer.byteLength(data);
  const r = http.request({ method:m, path:p, port, host:"127.0.0.1", headers:h }, x => {
    if (x.headers["set-cookie"]) jar[who] = x.headers["set-cookie"][0].split(";")[0];
    let d=""; x.on("data",c=>d+=c);
    x.on("end",()=>res({status:x.statusCode, body:(()=>{try{return JSON.parse(d||"{}")}catch(e){return d}})()}));
  });
  r.on("error", rej); if (data) r.write(data); r.end();
});
const app = (w,m,p,b) => req_(w, APP_PORT, m, p, b);
const panel = (m,p,b) => req_("V", PANEL_PORT, m, p, b);

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-app-"));
const panDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-pan-"));
const KEY = fs.readFileSync(path.join(KEYS, "private-key.pem"), "utf8");

let panelSrv, appSrv, appOut = "", panelOut = "";
const bootPanel = () => { panelSrv = spawn(process.execPath, ["server.js"], { cwd: LIC, stdio:["ignore","pipe","pipe"],
  env:{...process.env, VENDOR_PRIVATE_KEY:KEY, ADMIN_PASSWORD:PW, DATA_DIR:panDir, PORT:String(PANEL_PORT)} });
  panelSrv.stdout.on("data",c=>panelOut+=c); panelSrv.stderr.on("data",c=>panelOut+=c); };
const bootApp = () => { appOut = "";
  appSrv = spawn(process.execPath, ["--no-warnings","server/index.js"], { cwd: APP, stdio:["ignore","pipe","pipe"],
  env:{...process.env, DATA_DIR:appDir, PORT:String(APP_PORT), SESSION_SECRET:"sv",
    LICENCE_SERVER:`http://127.0.0.1:${PANEL_PORT}`,
    SUPABASE_URL:`http://127.0.0.1:${STORE_PORT}`, SUPABASE_KEY:"k", SUPABASE_BUCKET:"shop-backups"} });
  appSrv.stdout.on("data",c=>appOut+=c); appSrv.stderr.on("data",c=>appOut+=c); };
const stopApp = () => new Promise(r => { if(!appSrv) return r(); appSrv.once("exit",r); appSrv.kill("SIGTERM"); setTimeout(r, 9000); });
const waitFor = async (fn,w) => { for(let i=0;i<120;i++){ try{ await fn(); return; }catch(e){ await new Promise(r=>setTimeout(r,250)); } } throw new Error(w+" no start\n"+appOut+panelOut); };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
process.on("exit",()=>{try{panelSrv&&panelSrv.kill()}catch(e){};try{appSrv&&appSrv.kill()}catch(e){};try{ss.close()}catch(e){}});
/* /api/businesses answers with an object; count whichever shape it uses. */
const bizCount = r => { const b = r.body;
  const rows = Array.isArray(b) ? b : (b.businesses || b.list || []);
  return rows.length; };
const day = n => new Date(Date.now()+n*86400000).toISOString().slice(0,10);

(async () => {
 try {
  await new Promise(r => ss.listen(STORE_PORT, "127.0.0.1", r));
  bootPanel(); await waitFor(()=>panel("GET","/api/health"), "panel");
  bootApp();   await waitFor(()=>app("A","GET","/api/auth/mode"), "app");

  console.log("\nA 30-day demo, signed in, with real books entered\n");
  await panel("POST","/api/login",{password:PW});
  const d = (await panel("POST","/api/customers/demo",{shopName:"Gupta Timber",phone:"9820088888",days:30})).body;
  await app("A","POST","/api/auth/shop-login",{username:d.handover.login,password:d.handover.password});
  const staff = (await app("A","GET","/api/auth/staff-list")).body;
  await app("A","POST","/api/auth/login",{staffId:staff[0].id,pin:"1234"});
  await app("A","POST","/api/products",{name:"GUPTA ONLY PLY",brand:"G",unit:"Pc",gstRate:18,sizes:[{label:"8x4",price:1234,stock:0}]});
  await app("A","POST","/api/customers",{name:"GUPTA ONLY PARTY",phone:"9000000009"});
  check("their product is there", (await app("A","GET","/api/products")).body.map(p=>p.name), ["GUPTA ONLY PLY"]);

  /* a backup, then the disk destroyed — exactly a redeploy */
  const bk = await app("A","POST","/api/backup/run",{});
  if(bk.status !== 200) console.log("    backup said:", JSON.stringify(bk.body).slice(0,200));
  await sleep(1500);
  check("the login map reached the backup",
    [...objects.keys()].some(k=>/--tenants\.db$/.test(k)), true);

  console.log("\n1. The container is replaced and the disk wiped\n");
  await stopApp();
  fs.rmSync(appDir, { recursive:true, force:true });
  jar.A = "";
  bootApp(); await waitFor(()=>app("A","GET","/api/auth/mode"), "app2");
  check("it restored", /Restored database from cloud backup/.test(appOut), true);

  const back = await app("A","POST","/api/auth/shop-login",{username:d.handover.login,password:d.handover.password});
  check("they can sign in again", back.status, 200);
  check("...into THEIR shop", back.body.shop, "Gupta Timber");
  const st2 = (await app("A","GET","/api/auth/staff-list")).body;
  await app("A","POST","/api/auth/login",{staffId:st2[0].id,pin:"1234"});
  check("AND THEIR BOOKS ARE THERE", (await app("A","GET","/api/products")).body.map(p=>p.name), ["GUPTA ONLY PLY"]);
  check("...customers too", (await app("A","GET","/api/customers")).body.map(c=>c.name), ["GUPTA ONLY PARTY"]);
  check("no second company was invented", bizCount(await app("A","GET","/api/businesses")), 1);

  console.log("\n2. Now lose the login map ENTIRELY and try again\n");
  await stopApp();
  fs.rmSync(path.join(appDir, "tenants.db"), { force:true });
  try { fs.rmSync(path.join(appDir, "tenants.db-wal"), { force:true }); } catch(e){}
  jar.A = "";
  bootApp(); await waitFor(()=>app("A","GET","/api/auth/mode"), "app3");
  const rec = await app("A","POST","/api/auth/shop-login",{username:d.handover.login,password:d.handover.password});
  check("they still get in", rec.status, 200);
  const st3 = (await app("A","GET","/api/auth/staff-list")).body;
  await app("A","POST","/api/auth/login",{staffId:st3[0].id,pin:"1234"});
  check("STILL THEIR OWN BOOKS, not a new empty shop",
    (await app("A","GET","/api/products")).body.map(p=>p.name), ["GUPTA ONLY PLY"]);
  check("and still exactly one company", bizCount(await app("A","GET","/api/businesses")), 1);
  console.log("    found by the code stamped inside their own books");

  console.log("\n3. The demo runs out — then they pay\n");
  const { DatabaseSync } = require("node:sqlite");
  /* Expired in BOTH places. Winding back only the local cache proves
     nothing now: the app re-asks the vendor before refusing anyone, and
     the vendor would rightly say the demo is still running. */
  const pdb = new DatabaseSync(path.join(panDir, "licences.db"));
  pdb.prepare("UPDATE customers SET expires_on = ? WHERE id = ?").run(day(-1), d.id);
  pdb.close();
  const t = new DatabaseSync(path.join(appDir, "tenants.db"));
  t.prepare("UPDATE tenants SET expires_on = ? WHERE username = ?").run(day(-1), d.handover.login.toLowerCase());
  t.close();
  jar.A = "";
  const dead = await app("A","POST","/api/auth/shop-login",{username:d.handover.login,password:d.handover.password});
  check("expired demo is refused", dead.status, 403);
  check("...in the words promised", dead.body.error, "Demo License Expired – Please Contact Admin");

  await panel("POST",`/api/customers/${d.id}/convert-to-paid`,{until:"2027-12-31"});
  const paid = await app("A","POST","/api/auth/shop-login",{username:d.handover.login,password:d.handover.password});
  check("AFTER PAYING, THEY GET STRAIGHT BACK IN", paid.status, 200);
  check("...as a paid customer", paid.body.plan, "paid");
  const st4 = (await app("A","GET","/api/auth/staff-list")).body;
  await app("A","POST","/api/auth/login",{staffId:st4[0].id,pin:"1234"});
  check("with everything they entered during the demo",
    (await app("A","GET","/api/products")).body.map(p=>p.name), ["GUPTA ONLY PLY"]);
  console.log("    the cached demo date did not lock out a paying customer");

  console.log(fails ? `\n${fails} FAILED\n` : "\nAll passed\n");
 } catch (e) { console.error("\n  ERROR: "+e.stack+"\n--- app ---\n"+appOut+"\n--- panel ---\n"+panelOut); fails++; }
 finally { await stopApp(); try{panelSrv.kill()}catch(e){} try{ss.close()}catch(e){}
   try{fs.rmSync(appDir,{recursive:true,force:true})}catch(e){}
   try{fs.rmSync(panDir,{recursive:true,force:true})}catch(e){}
   process.exit(fails?1:0); }
})();
