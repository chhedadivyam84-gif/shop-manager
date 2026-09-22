/* ============================================================
   WHERE THE BRANDING ARTWORK LANDS ON A PRINTED DOCUMENT

   The band's whole promise is that it cannot overlap anything. It keeps
   that promise by being a block in the document's FLOW rather than a box
   at coordinates: "bottom right" as coordinates sits on top of the
   signature on a long bill and beside it on a short one, whereas a block
   that takes its own space cannot land on anything, at any length, on
   either paper.

   So what is worth testing is the ORDER — that the band comes out in the
   right place among the document's own blocks — and the three rules that
   protect the artwork itself:

     · a particular with no artwork changes nothing, anywhere
     · each mark stays with its own particular
     · the proportions are kept unless the shop says otherwise

   docPrint.js builds the quotation, the orders, the returns and the
   selection slip. It is a browser module, so it is given the one global
   it wants and then asked directly.

   Run:  node test/artwork-band.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), vm = require("vm");

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

/* The module closes over `window`; nothing it does on this path touches
   the DOM, so a plain object is the whole environment it needs. */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js/docPrint.js"), "utf8"), sandbox);
const DocPrint = sandbox.window.DocPrint;

const PNG_A = "data:image/png;base64,AAAA";
const PNG_B = "data:image/png;base64,BBBB";

const quotation = {
  quotation_no: "QT-1", date: "2026-09-22", total: 0,
  items: [
    { product_id: "P1", name: "Sagwan Gold Ply 19mm", qty: 10, rate: 100 },
    { product_id: "P2", name: "Konkan Marine Board",  qty: 5,  rate: 200 },
    { product_id: "P3", name: "Plain Commercial Ply", qty: 4,  rate: 50  },
  ]
};
const ART = { P1: PNG_A, P2: PNG_B };          /* P3 deliberately has none */

const build = (artwork, cfg, doc) => DocPrint.build("sales_quotation", doc || quotation, {
  settings: { business_name: "A Shop" },
  party: { name: "A Customer" },
  config: {},
  artwork, artworkCfg: cfg
}).html;

/* The document's own blocks, in printed order. */
const blocks = html => (html.match(/<div class="(dp-[a-z-]+)"/g) || [])
  .map(m => /class="(dp-[a-z-]+)"/.exec(m)[1])
  .filter(c => ["dp-banner","dp-shop","dp-parties","dp-table-wrap","dp-art","dp-lower","dp-sign","dp-footline"].includes(c));
const imgsIn = html => (html.match(/<img src="([^"]*)"/g) || []).map(m => /src="([^"]*)"/.exec(m)[1]);

/* ------------------------------------------------------------------ */
console.log("--- a document with no artwork is the document that printed before");
const plain = build(null, null);
ok("no band is emitted", !blocks(plain).includes("dp-art"), blocks(plain).join(" "));
ok("nothing else moved",
   blocks(plain).join(" ") === "dp-banner dp-shop dp-parties dp-table-wrap dp-lower dp-sign",
   blocks(plain).join(" "));
const noneHaveArt = build({}, { on: true });
ok("an empty artwork map is the same as none", !blocks(noneHaveArt).includes("dp-art"));
const notOn = build(ART, { on: false });
ok("switched off, the band is absent even with artwork to show", !blocks(notOn).includes("dp-art"));

/* ------------------------------------------------------------------ */
console.log("--- the band lands where it was asked to, and takes its own space");
const at = v => blocks(build(ART, { on: true, vAlign: v }));
ok("TOP is above the item table",
   at("top").join(" ") === "dp-banner dp-shop dp-parties dp-art dp-table-wrap dp-lower dp-sign",
   at("top").join(" "));
ok("MIDDLE is between the table and the totals",
   at("middle").join(" ") === "dp-banner dp-shop dp-parties dp-table-wrap dp-art dp-lower dp-sign",
   at("middle").join(" "));
ok("BOTTOM is under the totals and above the signature",
   at("bottom").join(" ") === "dp-banner dp-shop dp-parties dp-table-wrap dp-lower dp-art dp-sign",
   at("bottom").join(" "));
ok("and it appears exactly ONCE, never in two places at once",
   ["top","middle","bottom"].every(v => at(v).filter(b => b === "dp-art").length === 1));
ok("an unknown position falls back rather than vanishing",
   blocks(build(ART, { on: true, vAlign: "sideways" })).includes("dp-art"));

/* ------------------------------------------------------------------ */
console.log("--- across the page");
const just = a => /justify-content:([a-z-]+);/.exec(build(ART, { on: true, align: a }))[1];
ok("left", just("left") === "flex-start", just("left"));
ok("centre", just("center") === "center", just("center"));
ok("right", just("right") === "flex-end", just("right"));
ok("a bad value centres rather than breaking the style attribute",
   just("elsewhere") === "center", just("elsewhere"));

/* ------------------------------------------------------------------ */
console.log("--- EACH PARTICULAR KEEPS ITS OWN");
const shown = imgsIn(build(ART, { on: true }));
ok("both marks are printed", shown.length === 2, JSON.stringify(shown));
ok("in the order the lines appear", shown[0] === PNG_A && shown[1] === PNG_B, JSON.stringify(shown));
ok("the particular with no artwork contributes none", !shown.includes(""), JSON.stringify(shown));

/* The same board on three lines is ONE mark, not three. */
const repeated = { ...quotation, items: [
  { product_id: "P1", name: "Sagwan 19mm", qty: 1, rate: 1 },
  { product_id: "P1", name: "Sagwan 19mm", qty: 2, rate: 1 },
  { product_id: "P1", name: "Sagwan 19mm", qty: 3, rate: 1 },
]};
ok("one particular on three lines prints one mark",
   imgsIn(build(ART, { on: true }, repeated)).length === 1);

/* A line whose particular was deleted, or which never had one. */
const orphan = { ...quotation, items: [{ name: "Loose line, no particular", qty: 1, rate: 1 }] };
ok("a line with no particular at all is harmless",
   !blocks(build(ART, { on: true }, orphan)).includes("dp-art"));

/* ------------------------------------------------------------------ */
console.log("--- size, shape and turning");
const styleOf = cfg => /<span class="dp-art-item" style="([^"]*)"/.exec(build(ART, cfg))[1];
ok("width is used as given", /width:55mm/.test(styleOf({ on: true, width: 55 })), styleOf({ on: true, width: 55 }));
ok("a height of 0 is left to the artwork's own shape",
   !/height:/.test(styleOf({ on: true, width: 40, height: 0 })), styleOf({ on: true, width: 40, height: 0 }));
ok("a height that was given is used", /height:25mm/.test(styleOf({ on: true, height: 25 })));
ok("a silly width is capped rather than running off the page",
   /width:190mm/.test(styleOf({ on: true, width: 9999 })), styleOf({ on: true, width: 9999 }));
ok("a negative width falls back to the default",
   /width:40mm/.test(styleOf({ on: true, width: -5 })), styleOf({ on: true, width: -5 }));

ok("the proportions are kept by default",
   !/object-fit:fill/.test(build(ART, { on: true })));
ok("and only given up when the shop says so",
   /object-fit:fill/.test(build(ART, { on: true, keepRatio: false })));

ok("no turn means no transform", !/rotate\(/.test(build(ART, { on: true })));
ok("a quarter turn is applied", /rotate\(90deg\)/.test(build(ART, { on: true, rotate: 90 })));
/* A turned artwork lies across the page, so its BOX swaps dimensions —
   otherwise it runs out of its container and over what is below it. */
ok("and the box swaps its dimensions to hold it",
   /width:30mm;height:40mm/.test(styleOf({ on: true, width: 40, height: 30, rotate: 90 })),
   styleOf({ on: true, width: 40, height: 30, rotate: 90 }));
ok("a nonsense angle is ignored", !/rotate\(/.test(build(ART, { on: true, rotate: 37 })));

console.log("");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
