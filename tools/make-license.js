/* ============================================================
   LICENCE KEY GENERATOR  —  VENDOR ONLY
   ------------------------------------------------------------
   Mints a signed subscription key for one customer.

   *** NEVER include this file, or private-key.pem, in anything
   *** you send to a customer. Whoever holds the private key can
   *** issue themselves an unlimited licence.

   Usage:
     node tools/make-license.js <private-key.pem> "<Shop Name>" <YYYY-MM-DD>

   Example (one year):
     node tools/make-license.js ../private-key.pem "Sharma Plywood" 2027-08-07
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");

const [, , keyPath, shop, expires] = process.argv;

if (!keyPath || !shop || !expires) {
  console.error('Usage: node tools/make-license.js <private-key.pem> "<Shop Name>" <YYYY-MM-DD>');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error("Expiry must look like 2027-08-07");
  process.exit(1);
}
if (Number.isNaN(Date.parse(expires + "T00:00:00Z"))) {
  console.error("That expiry isn't a real date.");
  process.exit(1);
}

const privateKey = fs.readFileSync(keyPath, "utf8");
const payload = Buffer.from(JSON.stringify({
  shop,
  expires,
  issued: new Date().toISOString().slice(0, 10)
}), "utf8");

const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signature = crypto.sign(null, payload, privateKey);
const key = `${b64url(payload)}.${b64url(signature)}`;

console.log("");
console.log(`  Shop    : ${shop}`);
console.log(`  Expires : ${expires}`);
console.log("");
console.log("  Licence key — send this to the customer:");
console.log("");
console.log("  " + key);
console.log("");
console.log("  They paste it into Settings -> Subscription.");
console.log("");
