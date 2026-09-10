/* ============================================================
   ASSEMBLE A WORKERS-COMPATIBLE COPY OF server/

   The route files are not edited and not forked. They are copied
   verbatim from ../server, and then a small overlay is laid on top
   replacing only the modules that genuinely cannot run on Workers —
   the ones that touch the filesystem, open a SQLite file, or shell out
   to a printer.

   Copying rather than editing in place matters: ../server stays the
   single source of truth, Render keeps running it, and re-running this
   script picks up any change made there. The overlay is the only thing
   maintained twice, and it is deliberately small.

   Run: node tools/build-server.js [--report]
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "server");
const OVERLAY = path.join(HERE, "..", "overlay");
const OUT = path.join(HERE, "..", "server");

const REPORT_ONLY = process.argv.includes("--report");

/* Modules that cannot come across at all. Copying them would pull fs and
   child_process into the bundle and fail the build; the overlay supplies a
   Workers version of each, or a stub that explains itself when called. */
const NEVER_COPY = new Set([
  "db.js",              /* opens SQLite files; the DO's storage replaces it   */
  "db-schema.js",       /* builds the schema on disk; the DO does it instead  */
  "sessionStore.js",    /* express-session store; sessions live in DO storage */
  "restore.js",         /* restores a .db file from disk                      */
  "backup.js",          /* writes .db files; R2 + alarms replace it           */
  "cloudStore.js",      /* Supabase client over fs                            */
  "secretBox.js",       /* reads a key file from disk                         */
  "tenants.js",         /* its own SQLite file                                */
  "attachments.js",     /* writes uploads to disk                             */
  "billScan.js",        /* writes scans to disk                               */
  "index.js",           /* the Express bootstrap; src/index.js is the entry    */
]);

const NEVER_COPY_DIRS = new Set(["printing"]);   /* child_process + SumatraPDF */

function walk(dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (NEVER_COPY_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".js")) {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(SRC);
const overlayFiles = fs.existsSync(OVERLAY) ? walk(OVERLAY) : [];
const overlaySet = new Set(overlayFiles);

/* ---------- what is still unportable AFTER the overlay? ---------- */
const NODE_ONLY = /require\(["'](fs|path|child_process|node:sqlite|node:fs)["']\)|__dirname|process\.env\.DATA_DIR/;
const offenders = [];
for (const rel of files) {
  if (NEVER_COPY.has(path.basename(rel)) && !rel.includes("/")) continue;
  if (overlaySet.has(rel)) continue;
  const text = fs.readFileSync(path.join(SRC, rel), "utf8");
  const hits = [];
  if (/require\(["'](fs|node:fs)["']\)/.test(text)) hits.push("fs");
  if (/require\(["']child_process["']\)/.test(text)) hits.push("child_process");
  if (/require\(["']node:sqlite["']\)/.test(text)) hits.push("node:sqlite");
  if (/__dirname/.test(text)) hits.push("__dirname");
  if (hits.length) offenders.push({ rel, hits });
}

if (REPORT_ONLY) {
  console.log(`source modules:  ${files.length}`);
  console.log(`overlay files:   ${overlayFiles.length}`);
  console.log(`never copied:    ${NEVER_COPY.size} files + ${[...NEVER_COPY_DIRS].join(", ")}/\n`);
  if (!offenders.length) {
    console.log("nothing left that needs an overlay");
  } else {
    console.log(`STILL UNPORTABLE (${offenders.length}) — each needs an overlay or a stub:`);
    for (const o of offenders) console.log(`  ${o.rel.padEnd(34)} ${o.hits.join(", ")}`);
  }
  process.exit(0);
}

/* ---------- build ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
let copied = 0, overlaid = 0, skipped = 0;

for (const rel of files) {
  if (NEVER_COPY.has(path.basename(rel)) && !rel.includes("/")) { skipped++; continue; }
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), dest);
  copied++;
}

for (const rel of overlayFiles) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(OVERLAY, rel), dest);
  overlaid++;
}

/* The route files and overlays are CommonJS, but cloudflare/package.json
   declares "type": "module", which would make Node and esbuild read every
   .js here as ESM and break every module.exports. A package.json scoped to
   this subtree overrides that for the whole tree. */
fs.writeFileSync(path.join(OUT, "package.json"), '{ "type": "commonjs" }\n');

/* Four route files do require("../../public/js/pricing.js") — the pricing
   rules are shared between the server and the browser deliberately, so a
   discount is computed the same way in both. That relative path has to keep
   resolving, so the shared module is mirrored at the same depth here rather
   than the requires being rewritten. */
const SHARED = ["js/pricing.js"];
for (const rel of SHARED) {
  const from = path.join(HERE, "..", "..", "public", rel);
  const to = path.join(HERE, "..", "public", rel);
  if (!fs.existsSync(from)) { console.warn(`shared module missing: ${from}`); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
/* ...and it is CommonJS too, for the same "type": "module" reason. */
fs.writeFileSync(path.join(HERE, "..", "public", "package.json"), '{ "type": "commonjs" }\n');

console.log(`copied ${copied} modules from ../server`);
console.log(`overlaid ${overlaid} Workers replacements`);
console.log(`skipped ${skipped} that cannot cross`);
if (offenders.length) {
  console.log(`\nWARNING — ${offenders.length} copied module(s) still reference Node-only APIs:`);
  for (const o of offenders.slice(0, 12)) console.log(`  ${o.rel.padEnd(34)} ${o.hits.join(", ")}`);
}
