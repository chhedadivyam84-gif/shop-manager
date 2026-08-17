/* Standing guard against the pieces-vs-selling-unit mix.
   Run it against the source; it fails loudly if anyone reintroduces the
   pattern that produced "42 in one column and 2 in the next". */
const fs = require("fs");
const path = require("path");
const ROOT = process.argv[2] || "C:/Users/prafu/shop-manager";
const R = p => fs.readFileSync(path.join(ROOT, p), "utf8");

/* The rule, stated once:
     pieces        = physical count. This and ONLY this moves stock.
     qty           = billed quantity in the selling unit (sq.ft, Rft...).
     rate          = money per SELLING UNIT.        qty  x rate  = money  OK
     cost_price    = landed cost per PIECE.         pieces x cost = money  OK
   So `qty * cost_price` and `pieces * rate` are both unit mixes. */
const BAD = [
  { re: /\bii\.qty\s*\*\s*(COALESCE\()?\s*ps\.cost_price/,  why: "sq.ft x cost-per-piece — cost must use pieces" },
  { re: /\bpi\.qty\s*\*\s*(COALESCE\()?\s*ps\.cost_price/,  why: "sq.ft x cost-per-piece — cost must use pieces" },
  { re: /\bpieces\s*\*\s*\w*[Rr]ate\b(?!.*per[_ ]?piece)/,  why: "pieces x per-selling-unit rate — money must use qty" },
  { re: /closing_stock[^;]*\*\s*purchaseRate/,             why: "pieces x per-selling-unit rate for stock value" },
  { re: /SUM\(\s*ii\.qty\s*\)[^;]*stock/i,                 why: "summing sq.ft as a stock movement" }
];

const FILES = [];
(function walk(d){
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    if (["node_modules", ".git", "data"].includes(e.name)) continue;
    const rel = d + "/" + e.name;
    if (e.isDirectory()) walk(rel); else if (e.name.endsWith(".js")) FILES.push(rel.replace(/^\.\//, ""));
  }
})("server");

const hits = [];
for (const f of FILES) {
  R(f).split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;            // comments explain the rule
    for (const b of BAD) if (b.re.test(line)) hits.push(`${f}:${i + 1}  ${b.why}\n      ${line.trim().slice(0, 96)}`);
  });
}

if (hits.length) {
  console.log(`UNIT MIX DETECTED (${hits.length}):`);
  hits.forEach(h => console.log("  " + h));
  process.exit(1);
}
console.log("unit guard: no pieces/selling-unit mixes found in server code");
