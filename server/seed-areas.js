/* ============================================================
   DELIVERY AREAS — CENTRAL LINE

   Swagat Ply delivers along the Central Line and wants each station split
   into East and West, so that (say) Bhandup East and Bhandup West appear as
   separate rounds in Delivery Dispatch.

   This exists because the shop runs on more than one machine: the PC in the
   shop and the copy on Render each hold their own database, and typing
   ninety areas twice invites the two lists to drift apart. Seeding them from
   code keeps every device showing the same rounds.

   Two properties make it safe to run on every boot:

     - It only ever INSERTs. An area already present is left exactly as it
       is, including one the shop has retired — re-adding a retired area
       would quietly resurrect a round they chose to stop running.

     - It is limited to THIS shop, by name. A buyer's fresh install is called
       "My Shop" until they set their own name, so a plywood dealer in another
       city never finds Mumbai stations in their dispatch list.
   ============================================================ */
const { uid } = require("./util");

const STATE = "Maharashtra";
const CITY = "Mumbai";
const ONLY_FOR_SHOP = "Swagat Ply";

// CSMT through Kalyan, where the line splits.
const MAIN = ["CSMT", "Masjid", "Sandhurst Road", "Byculla", "Chinchpokli",
  "Currey Road", "Parel", "Dadar", "Matunga", "Sion", "Kurla", "Vidyavihar",
  "Ghatkopar", "Vikhroli", "Kanjurmarg", "Bhandup", "Nahur", "Mulund", "Thane",
  "Kalwa", "Mumbra", "Diva", "Kopar", "Dombivli", "Thakurli", "Kalyan"];

const KASARA = ["Shahad", "Ambivli", "Titwala", "Khadavli", "Vasind", "Asangaon",
  "Atgaon", "Thansit", "Khardi", "Kasara"];

const KARJAT = ["Vitthalwadi", "Ulhasnagar", "Ambernath", "Badlapur", "Vangani",
  "Shelu", "Neral", "Bhivpuri Road", "Karjat"];

// Western Line, Churchgate to Virar. Dadar appears on both lines; the loop
// below adds each area once, so it is listed here as it really is rather than
// left out to avoid a clash.
const WESTERN = ["Churchgate", "Marine Lines", "Charni Road", "Grant Road",
  "Mumbai Central", "Mahalaxmi", "Lower Parel", "Prabhadevi", "Dadar",
  "Matunga Road", "Mahim", "Bandra", "Khar", "Santacruz", "Vile Parle",
  "Andheri", "Jogeshwari", "Ram Mandir", "Goregaon", "Malad", "Kandivali",
  "Borivali", "Dahisar", "Mira Road", "Bhayandar", "Naigaon", "Vasai Road",
  "Nalasopara", "Virar"];

// Harbour Line: CSMT to Panvel, plus the branch that runs up to Goregaon.
// Several of these stations are shared with Central and Western — Kurla and
// Bandra carry all the traffic they do precisely because they are junctions.
const HARBOUR = ["CSMT", "Masjid", "Sandhurst Road", "Dockyard Road", "Reay Road",
  "Cotton Green", "Sewri", "Vadala Road", "GTB Nagar", "Chunabhatti", "Kurla",
  "Tilak Nagar", "Chembur", "Govandi", "Mankhurd", "Vashi", "Sanpada",
  "Juinagar", "Nerul", "Seawoods", "Belapur CBD", "Kharghar", "Mansarovar",
  "Khandeshwar", "Panvel",
  // the Goregaon branch — "Khar" spelt as the Western list has it, so the
  // shop does not end up with both "Khar" and "Khar Road"
  "Bandra", "Khar", "Santacruz", "Vile Parle", "Andheri", "Ram Mandir", "Goregaon"];

/* The shop's own delivery rounds, by station. Both copies of the app hold
   their own database, so a round typed into one would not exist in the other —
   seeding them keeps the PC and the cloud copy showing the same rounds.

   Applied ONLY where the route is still blank. A round the shop re-plans in
   the Areas screen must survive the next restart; overwriting it every boot
   would make that screen useless. */
const ROUTES = {
  "Route 1": ["Malad", "Kandivali", "Borivali"],
  // Ram Mandir sits between Jogeshwari and Goregaon, so it rides with the van
  // that already does both.
  "Route 2": ["Goregaon", "Andheri", "Jogeshwari", "Ram Mandir"],
  "Route 3": ["Bhandup", "Mulund", "Nahur"],
  "Route 4": ["Thane", "Kalwa", "Mumbra"],
  "Route 5": ["Dombivli", "Thakurli", "Kalyan"],
  "Route 6": ["Diva", "Kopar", "Vitthalwadi"],
  "Route 7": ["Ulhasnagar", "Ambernath", "Badlapur"],

  /* The rest, laid out three neighbouring stations to a van, following each
     line outward. Grouped by geography rather than by how the shop actually
     drives — so treat these as a first cut to correct in the Areas screen,
     which is exactly the case the fill-blanks-only rule exists to protect. */

  // Western, north of Borivali
  "Route 8":  ["Dahisar", "Mira Road", "Bhayandar"],
  "Route 9":  ["Naigaon"],
  "Route 10": ["Virar", "Nalasopara", "Vasai Road"],

  // Western, south of Andheri towards Churchgate
  "Route 11": ["Vile Parle", "Santacruz", "Khar"],
  "Route 12": ["Bandra", "Mahim", "Matunga Road"],
  "Route 13": ["Dadar", "Prabhadevi", "Lower Parel"],
  "Route 14": ["Mahalaxmi", "Mumbai Central", "Grant Road"],
  "Route 15": ["Charni Road", "Marine Lines", "Churchgate"],

  // Central, south of Bhandup towards CSMT
  "Route 16": ["Kanjurmarg", "Vikhroli", "Ghatkopar"],
  "Route 17": ["Vidyavihar", "Kurla", "Sion"],
  "Route 18": ["Matunga", "Parel", "Currey Road"],
  "Route 19": ["Chinchpokli", "Byculla", "Sandhurst Road"],
  "Route 20": ["Masjid", "CSMT"],

  // Kasara branch
  "Route 21": ["Shahad", "Ambivli", "Titwala"],
  "Route 22": ["Khadavli", "Vasind", "Asangaon"],
  "Route 23": ["Atgaon", "Thansit", "Khardi"],
  "Route 24": ["Kasara"],

  // Karjat branch, beyond Badlapur
  "Route 25": ["Vangani", "Shelu", "Neral"],
  "Route 26": ["Bhivpuri Road", "Karjat"],

  // Harbour, CSMT out to Panvel
  "Route 27": ["Dockyard Road", "Reay Road", "Cotton Green"],
  "Route 28": ["Sewri", "Vadala Road", "GTB Nagar"],
  "Route 29": ["Chunabhatti", "Tilak Nagar", "Chembur"],
  "Route 30": ["Govandi", "Mankhurd", "Vashi"],
  "Route 31": ["Sanpada", "Juinagar", "Nerul"],
  "Route 32": ["Seawoods", "Belapur CBD", "Kharghar"],
  "Route 33": ["Mansarovar", "Khandeshwar", "Panvel"]
};
const LINES = [
  { line: "Western", stations: WESTERN },
  { line: "Central", stations: MAIN },
  { line: "Central", stations: KASARA },
  { line: "Central", stations: KARJAT },
  { line: "Harbour", stations: HARBOUR }
];

/**
 * Every station area in list order, each carrying the station, the side and
 * the lines it sits on. A station on two lines appears ONCE, holding both —
 * Dadar is not two areas, and CSMT is not a choice between Central and Harbour.
 */
function stationAreas() {
  const byArea = new Map();
  for (const { line, stations } of LINES) {
    for (const station of stations) {
      for (const side of ["East", "West"]) {
        const area = `${station} ${side}`;
        if (!byArea.has(area)) byArea.set(area, { area, station, side, lines: [] });
        const entry = byArea.get(area);
        if (!entry.lines.includes(line)) entry.lines.push(line);
      }
    }
  }
  return [...byArea.values()];
}

/**
 * Adds any missing station areas and puts them in line order. Returns
 * { added, moved } — both 0 on every boot after the first, and both 0
 * forever on anyone else's install.
 */
function seedCentralLineAreas(db) {
  const nothing = { added: 0, moved: 0 };
  let shop = "";
  try {
    const row = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
    shop = (row && row.business_name) || "";
  } catch {
    return nothing;   // a database too old to have settings yet
  }
  if (shop.trim().toLowerCase() !== ONLY_FOR_SHOP.toLowerCase()) return nothing;

  const find = db.prepare("SELECT id FROM areas WHERE state = ? AND city = ? AND area = ?");
  const insert = db.prepare(
    "INSERT INTO areas (id, state, city, area, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const setParts = db.prepare("UPDATE areas SET station = ?, side = ? WHERE id = ?");
  const linkLine = db.prepare(
    "INSERT OR IGNORE INTO area_lines (area_id, line) VALUES (?, ?)");
  let sort = db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS n FROM areas WHERE state = ? AND city = ?"
  ).get(STATE, CITY).n;

  let added = 0;
  const run = db.transaction(() => {
    for (const s of stationAreas()) {
      const existing = find.get(STATE, CITY, s.area);
      let id;
      if (existing) {
        id = existing.id;
      } else {
        id = uid("AREA");
        insert.run(id, STATE, CITY, s.area, ++sort, Date.now());
        added++;
      }
      /* Applied to areas that already existed too: the first ninety were
         created before these columns did, and an area with no station on it
         cannot be found by a dispatcher filtering the round by line. */
      setParts.run(s.station, s.side, id);
      for (const line of s.lines) linkLine.run(id, line);
    }
  });
  run();
  /* Fixes before fills: a station being moved must land on its new round
     before anything else looks at what is still blank. */
  const fixed = applyRouteFixes(db);
  return { added, fixed, routed: applyRoutes(db), moved: orderStationAreas(db) };
}

/* A round that has to MOVE, not merely be filled in.
 *
 * The seed cannot do this on its own: filling blanks is what protects the
 * shop's own edits, so it must never overwrite a route that is already set.
 * But when the shop tells us a station belongs on a different van, that has to
 * reach every copy of the app, not just the machine it was typed on.
 *
 * Each correction therefore runs EXACTLY ONCE, recorded by id. After it has
 * run, the shop can move that station again and the change will stick — which
 * is the whole point of doing it this way rather than re-asserting the route
 * on every boot. */
const ROUTE_FIXES = [
  { id: "2026-08-19-virar-group", route: "Route 10", stations: ["Nalasopara", "Vasai Road"] }
];

function applyRouteFixes(db) {
  db.exec("CREATE TABLE IF NOT EXISTS seed_marks (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  const seen = db.prepare("SELECT 1 FROM seed_marks WHERE id = ?");
  const mark = db.prepare("INSERT OR IGNORE INTO seed_marks (id, at) VALUES (?, ?)");
  const move = db.prepare("UPDATE areas SET route = ? WHERE station = ?");

  let fixed = 0;
  const run = db.transaction(() => {
    for (const fix of ROUTE_FIXES) {
      if (seen.get(fix.id)) continue;
      for (const station of fix.stations) {
        const r = move.run(fix.route, station);
        fixed += r.changes || 0;
      }
      mark.run(fix.id, Date.now());
    }
  });
  run();
  return fixed;
}

/**
 * Fills in the shop's rounds, matching on station so "Malad", "Malad East" and
 * "Malad West" all land on the same round — the older bills booked against the
 * plain name belong to that van too.
 *
 * Only ever writes over a BLANK route. Anything the shop has set stands.
 */
function applyRoutes(db) {
  const rows = db.prepare(
    "SELECT id, area, station, route FROM areas WHERE route IS NULL OR route = ''").all();
  const update = db.prepare("UPDATE areas SET route = ? WHERE id = ?");

  let routed = 0;
  const run = db.transaction(() => {
    for (const [route, stations] of Object.entries(ROUTES)) {
      for (const row of rows) {
        if (stations.includes(row.station) || stations.includes(row.area)) {
          update.run(route, row.id);
          routed++;
        }
      }
    }
  });
  run();
  return routed;
}

/**
 * Puts the station areas into line order — Western, then Central — leaving
 * every other area alone and ahead of them, in the order the shop already
 * had. Only sort_order is touched: no area is added, removed or retired.
 *
 * Safe to run on each boot because nothing else ever writes sort_order; the
 * areas screen can create and retire, but not reorder.
 */
function orderStationAreas(db) {
  const rank = new Map(stationAreas().map((s, i) => [s.area, i]));
  const rows = db.prepare(
    "SELECT id, area, sort_order FROM areas WHERE state = ? AND city = ? ORDER BY sort_order, area"
  ).all(STATE, CITY);

  const others = rows.filter(r => !rank.has(r.area));
  const stations = rows.filter(r => rank.has(r.area))
    .sort((a, b) => rank.get(a.area) - rank.get(b.area));

  const update = db.prepare("UPDATE areas SET sort_order = ? WHERE id = ?");
  let moved = 0;
  const run = db.transaction(() => {
    [...others, ...stations].forEach((row, i) => {
      if (row.sort_order !== i) { update.run(i, row.id); moved++; }
    });
  });
  run();
  return moved;
}

module.exports = { seedCentralLineAreas };
