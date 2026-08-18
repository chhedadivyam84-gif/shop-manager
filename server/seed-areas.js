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

/* Which line each run of stations belongs to. Western first, then Central,
   then Harbour: that is the order the shop scans in Delivery Dispatch, and the
   areas list has no other ordering control — sort_order is only ever set when
   an area is created. */
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
  return { added, moved: orderStationAreas(db) };
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
