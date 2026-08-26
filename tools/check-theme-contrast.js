/* The claim: every theme shifts HUE and leaves LIGHTNESS alone, which is
   what makes contrast come out the same in all of them. Checked against the
   stylesheet rather than guessed at. */
const fs = require("fs");
const css = fs.readFileSync("public/css/style.css", "utf8");

const parseBlock = (src) => {
  const out = {};
  src.split(/;/).forEach(line => {
    const m = /(--[a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(line);
    if (m) out[m[1]] = { L: +m[2], C: +m[3], H: +m[4] };
  });
  return out;
};

const rootSrc = css.slice(css.indexOf(":root{"), css.indexOf("}", css.indexOf(":root{")));
const base = parseBlock(rootSrc);

const themes = [...css.matchAll(/html\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)];
console.log(`  base tokens read: ${Object.keys(base).length}`);
console.log(`  themes found    : ${themes.length}\n`);

let bad = 0;
for (const [, name, body] of themes) {
  const t = parseBlock(body);
  const drift = [];
  for (const [k, v] of Object.entries(t)) {
    if (!base[k]) { drift.push(`${k} is not a base token`); continue; }
    if (Math.abs(v.L - base[k].L) > 0.021) {
      drift.push(`${k} lightness ${base[k].L} -> ${v.L}`);
    }
  }
  const hueMoved = Object.entries(t).filter(([k, v]) => base[k] && v.H !== base[k].H).length;
  if (drift.length) { bad++; console.log(`  FAIL ${name}: ${drift.join("; ")}`); }
  else console.log(`  PASS ${name.padEnd(14)} ${Object.keys(t).length} tokens re-hued, ${hueMoved} changed hue, lightness unchanged`);
}

/* and the status colours must be untouched in every scheme */
const statusLeaked = themes.filter(([, , body]) => /--(ok|danger|warn)/.test(body)).map(m => m[1]);
console.log("");
console.log(statusLeaked.length
  ? `  FAIL green/red/amber recoloured in: ${statusLeaked.join(", ")}`
  : "  PASS green, amber and red are identical in every scheme");
process.exit(bad || statusLeaked.length ? 1 : 0);
