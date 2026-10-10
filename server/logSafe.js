/* ============================================================
   WHAT AN ERROR MAY SAY IN A LOG

   The server's logs go to the host — Render — and are kept there, readable
   by anybody with access to the dashboard. So a log line is a place a
   shop's data can leak to, and the error handler was one.

   It did console.error(err). When a request arrives with a body that is
   not valid JSON, Express parses it, fails, and hangs the RAW BODY on the
   error it raises — err.body. Printing the error printed that. A garbled
   sign-in request therefore wrote the staff member's PIN into the host's
   logs; a garbled invoice wrote the customer's name, phone and address.
   Found by sending one and reading what came out.

   Node's JSON parser can also quote a slice of the input inside its own
   message ('Unexpected token x, "{"pin":"4…" is not valid JSON'), so the
   message is not safe to print as it stands either.

   What is kept is what is needed to find the fault: what kind of error,
   which route, and where in the code — never what was sent.
   ============================================================ */

/* Anything in quotes inside an error message is a slice of somebody's
   input or of a row. The shape of the message survives; the content
   does not. */
function scrubMessage(msg) {
  return String(msg == null ? "" : msg)
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    /* Long digit runs: phone numbers, account numbers, PINs. */
    .replace(/\b\d{4,}\b/g, "#")
    .slice(0, 300);
}

/**
 * An error, reduced to what a log may hold.
 *
 * Deliberately does NOT include: err.body, err.raw, err.sql, the request
 * body, query string or headers, or any property not listed here.
 */
function describeError(err) {
  if (!err || typeof err !== "object") return { message: scrubMessage(err) };
  const out = {
    name: err.name || "Error",
    message: scrubMessage(err.message),
  };
  if (err.code) out.code = String(err.code);
  if (err.type) out.type = String(err.type);               // e.g. entity.parse.failed
  const status = err.status || err.statusCode;
  if (status) out.status = Number(status);
  /* The first few frames of OUR code — where it went wrong, which is
     what a person fixing it needs, and carries no data. */
  if (typeof err.stack === "string") {
    out.at = err.stack.split("\n").slice(1)
      .map(l => l.trim())
      .filter(l => /server[\\/]/.test(l))
      .slice(0, 3);
  }
  return out;
}

module.exports = { describeError, scrubMessage };
