/* ============================================================
   PIN VERIFICATION — byte-for-byte what the shop already runs

   server/auth.js stores PINs as `${salt}:${scryptSync(pin, salt, 64)}`.
   workerd's node:crypto produces identical output to Node's for the same
   inputs — verified before any of this was written, by comparing
   scryptSync("1234","deadbeef",64) on both and getting the same digest.

   That is the whole reason this file is three lines of logic instead of a
   migration plan: every PIN already set in every shop keeps working, and
   nobody has to re-enter anything at cutover.

   DO NOT "modernise" the algorithm here. Changing it silently invalidates
   every stored hash, and the failure looks like staff typing the wrong
   PIN rather than like a bug.
   ============================================================ */
import { scryptSync, timingSafeEqual } from "node:crypto";

export async function verifyPin(pin, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;

  let a, b;
  try {
    a = Buffer.from(hash, "hex");
    b = scryptSync(String(pin), salt, 64);
  } catch {
    return false;
  }

  /* Length is checked first because timingSafeEqual throws on a mismatch
     rather than returning false — the same guard server/auth.js has. */
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* Only needed when a PIN is set or changed. Same shape as hashPin() in
   server/auth.js so hashes written here are readable by the Express app
   and vice versa — which matters while both are running during cutover. */
export async function hashPin(pin) {
  const { randomBytes } = await import("node:crypto");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(String(pin), salt, 64).toString("hex")}`;
}
