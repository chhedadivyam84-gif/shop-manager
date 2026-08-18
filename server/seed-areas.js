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

function stationAreas() {
  const out = [];
  for (const line of [MAIN, KASARA, KARJAT, WESTERN]) {
    for (const station of line) {
      out.push(`${station} East`);
      out.push(`${station} West`);
    }
  }
  // Dadar is on both lines — one area, not two identical ones.
  return [...new Set(out)];
}

/**
 * Adds any missing Central Line areas. Returns how many were added — 0 on
 * every boot after the first, and 0 forever on anyone else's install.
 */
function seedCentralLineAreas(db) {
  let shop = "";
  try {
    const row = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
    shop = (row && row.business_name) || "";
  } catch {
    return 0;   // a database too old to have settings yet
  }
  if (shop.trim().toLowerCase() !== ONLY_FOR_SHOP.toLowerCase()) return 0;

  const find = db.prepare("SELECT id FROM areas WHERE state = ? AND city = ? AND area = ?");
  const insert = db.prepare(
    "INSERT INTO areas (id, state, city, area, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  let sort = db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS n FROM areas WHERE state = ? AND city = ?"
  ).get(STATE, CITY).n;

  let added = 0;
  const run = db.transaction(() => {
    for (const area of stationAreas()) {
      if (find.get(STATE, CITY, area)) continue;
      insert.run(uid("AREA"), STATE, CITY, area, ++sort, Date.now());
      added++;
    }
  });
  run();
  return added;
}

module.exports = { seedCentralLineAreas };
