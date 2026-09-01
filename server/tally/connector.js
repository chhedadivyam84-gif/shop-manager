/* ============================================================
   TALKING TO TALLY

   Tally listens for XML over plain HTTP on the machine it runs on —
   port 9000 by default, once "Enable ODBC/HTTP" is switched on in
   F12 > Advanced Configuration. There is no authentication and no TLS:
   Tally assumes anything that can reach the port is already inside the
   shop.

   THAT ASSUMPTION IS WHY THIS ONLY WORKS ON A LOCAL COPY. A server in a
   data centre cannot reach port 9000 on a shop's PC, and nobody should
   make it able to — that would put an unauthenticated write interface to
   the shop's books on the open internet. So this belongs to the copy
   running on the same network as Tally, and the hosted copy simply never
   turns it on.

   ONE DIRECTION. Every function here either asks Tally a question about
   itself (which companies exist, are you there) or hands it a voucher.
   Nothing reads a figure out of Tally and writes it into Shop Manager,
   and there is no function here that could.
   ============================================================ */
const http = require("http");

/* Tally is on the same machine or the same shop LAN. If it has not
   answered in fifteen seconds it is not going to — usually the company is
   not open, or the port is off. */
const TIMEOUT_MS = 15000;

/** XML text has to survive Tally's parser, which is stricter than most. */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    /* Control characters make Tally reject the whole envelope with a
       message that names no field, which is a miserable thing to debug. */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/** Tally wants dates as YYYYMMDD, with no separators. */
function tallyDate(iso) {
  const s = String(iso || "").slice(0, 10);
  return s.replace(/-/g, "");
}

/**
 * POST one XML envelope and hand back the raw reply.
 *
 * Deliberately not `fetch`: Tally answers with headers old enough that
 * some stacks refuse them, and this needs to work on whatever Node the
 * shop PC happens to be running.
 */
function post(settings, xml) {
  return new Promise((resolve) => {
    const body = Buffer.from(xml, "utf8");
    const req = http.request({
      host: settings.host || "localhost",
      port: Number(settings.port) || 9000,
      method: "POST",
      path: "/",
      headers: { "Content-Type": "text/xml;charset=utf-8", "Content-Length": body.length }
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => out += c);
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: out }));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, error:
        "Tally did not answer within 15 seconds. Usually this means no company " +
        "is open in Tally, or the request is waiting on a dialog on that screen." });
    });

    req.on("error", (e) => {
      /* The three failures a shopkeeper will actually hit, each with the
         thing to go and do about it. "ECONNREFUSED" on its own has never
         helped anybody. */
      const where = (settings.host || "localhost") + ":" + (settings.port || 9000);
      let msg;
      if (e.code === "ECONNREFUSED") {
        /* TALLY PRIME MOVED THIS SETTING, and the old directions send people
           hunting through a menu that no longer holds it. F12 > Advanced
           Configuration is where it lived in Tally ERP 9; in Tally Prime it
           is under F1 (Help) > Settings > Connectivity. Both are given,
           newest first, because a shop reading this is already stuck. */
        msg = "Nothing is listening at " + where + ". Open Tally and switch its " +
              "connectivity on: in TallyPrime press F1 (Help) > Settings > " +
              "Connectivity > Client/Server configuration, set 'TallyPrime acts as' " +
              "to Server (or Both) and the port to " + (settings.port || 9000) + ". " +
              "In the older Tally ERP 9 it is F12 > Advanced Configuration, " +
              "'Enable ODBC/HTTP' set to Yes.";
      } else if (e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" || e.code === "ETIMEDOUT") {
        msg = "Could not reach " + where + " on the network. Check the PC running " +
              "Tally is switched on and on the same network as this one.";
      } else if (e.code === "ENOTFOUND") {
        msg = "The name \"" + (settings.host || "localhost") + "\" could not be found. " +
              "Use the IP address of the PC running Tally.";
      } else {
        msg = "Could not reach Tally at " + where + " (" + e.code + ": " + e.message + ").";
      }
      resolve({ ok: false, error: msg, code: e.code });
    });

    req.write(body);
    req.end();
  });
}

/** Pull one tag's text out of a reply, without a full XML parser. */
function tag(xml, name) {
  const m = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i").exec(xml || "");
  return m ? m[1].trim() : "";
}
function tagAll(xml, name) {
  const re = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "gi");
  const out = []; let m;
  while ((m = re.exec(xml || ""))) out.push(m[1].trim());
  return out;
}

/**
 * What Tally said about an import.
 *
 * Tally answers a successful import with counts, and a rejected one with
 * LINEERROR — and, unhelpfully, still returns HTTP 200 either way. So the
 * body has to be read: treating 200 as success is how a sync reports
 * everything worked while Tally quietly accepted nothing.
 */
function readImportReply(body) {
  const err = tag(body, "LINEERROR");
  if (err) return { ok: false, error: err };

  const created = Number(tag(body, "CREATED") || 0);
  const altered = Number(tag(body, "ALTERED") || 0);
  const errors  = Number(tag(body, "ERRORS")  || 0);
  const exceptions = Number(tag(body, "EXCEPTIONS") || 0);

  if (errors > 0 || exceptions > 0) {
    return { ok: false, error: tag(body, "DESC") || "Tally reported " + errors + " error(s)." };
  }
  if (created === 0 && altered === 0) {
    return { ok: false, error:
      "Tally accepted the message but created nothing. The company name is " +
      "usually wrong, or that company is not open in Tally." };
  }
  return { ok: true, created, altered };
}

/* ------------------------------------------------------------------ */
/* asking Tally about itself                                           */
/* ------------------------------------------------------------------ */

/** Is Tally there, and which companies does it have open? */
async function companies(settings) {
  /* A BARE COLLECTION DOES NOT WORK HERE.

     The obvious request — TYPE Collection, ID "List of Companies", a
     COLLECTION of TYPE Company — is answered by TallyPrime with a CMPINFO
     summary and no names at all, so every company looked closed and the
     setup screen could never offer one to choose. Measured against
     TallyPrime build 27913: it replies STATUS 1, COMPANY 1, LEDGER 0, and
     not a single NAME, while the company sat plainly open on screen.

     Tally wants the whole report spelled out — report, form, part, line,
     field, collection — before it will export the names. Verbose for one
     string, and it is what actually answers.

     TYPE Company without ISINITIALIZE lists the companies that are OPEN,
     which is the question being asked: a company on disk but not loaded
     cannot be written to. */
  const xml =
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>' +
    '<TYPE>Data</TYPE><ID>ListOfCompanies</ID></HEADER>' +
    '<BODY><DESC><STATICVARIABLES>' +
    '<SVEXPORTFORMAT>$SysName:XML</SVEXPORTFORMAT>' +
    '</STATICVARIABLES><TDL><TDLMESSAGE>' +
    '<REPORT NAME="ListOfCompanies"><FORMS>ListOfCompanies</FORMS></REPORT>' +
    '<FORM NAME="ListOfCompanies"><PARTS>ListOfCompanies</PARTS></FORM>' +
    '<PART NAME="ListOfCompanies"><LINES>ListOfCompanies</LINES>' +
    '<REPEAT>ListOfCompanies : CollOfCompanies</REPEAT>' +
    '<SCROLLED>Vertical</SCROLLED></PART>' +
    '<LINE NAME="ListOfCompanies"><FIELDS>FldCmpName</FIELDS></LINE>' +
    '<FIELD NAME="FldCmpName"><SET>$Name</SET><XMLTAG>"NAME"</XMLTAG></FIELD>' +
    '<COLLECTION NAME="CollOfCompanies"><TYPE>Company</TYPE>' +
    '<FETCH>Name</FETCH></COLLECTION>' +
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';

  const r = await post(settings, xml);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };

  const names = tagAll(r.body, "NAME")
    .map(n => n.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  /* Tally repeats a name in more than one wrapper depending on version, so
     duplicates are expected rather than a sign of anything wrong. */
  return { ok: true, companies: [...new Set(names)], raw: r.body.slice(0, 600) };
}

/**
 * A connection test that means something.
 *
 * Reaching the port proves only that something is listening. This asks for
 * the company list, because that is the first thing every later call
 * depends on — and if the configured company is not among them, it says so
 * now rather than at the twentieth failed voucher.
 */
async function testConnection(settings) {
  const r = await companies(settings);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };

  const want = String(settings.company || "").trim();
  if (!want) {
    return { ok: true, companies: r.companies,
      message: r.companies.length
        ? "Tally answered. Now choose which company to sync into."
        : "Tally answered, but has no company open. Open one in Tally first." };
  }
  const found = r.companies.some(c => c.toLowerCase() === want.toLowerCase());
  if (!found) {
    return { ok: false, companies: r.companies,
      error: '"' + want + '" is not open in Tally. Open it there, or pick one of: ' +
             (r.companies.join(", ") || "(none open)") };
  }
  return { ok: true, companies: r.companies, message: 'Connected to "' + want + '".' };
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

/** Wrap one or more <TALLYMESSAGE> blocks in an import envelope. */
function importEnvelope(company, messages) {
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY>' +
    '<IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>' +
    '<STATICVARIABLES><SVCURRENTCOMPANY>' + esc(company) + '</SVCURRENTCOMPANY>' +
    '</STATICVARIABLES></REQUESTDESC><REQUESTDATA>' +
    messages.join("") +
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}

/** Same, for vouchers rather than masters. */
function voucherEnvelope(company, messages) {
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY>' +
    '<IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>' +
    '<STATICVARIABLES><SVCURRENTCOMPANY>' + esc(company) + '</SVCURRENTCOMPANY>' +
    '</STATICVARIABLES></REQUESTDESC><REQUESTDATA>' +
    messages.join("") +
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}

async function send(settings, xml) {
  const r = await post(settings, xml);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  const parsed = readImportReply(r.body);
  return parsed.ok
    ? { ok: true, created: parsed.created, altered: parsed.altered, raw: r.body.slice(0, 800) }
    : { ok: false, error: parsed.error, raw: r.body.slice(0, 800) };
}

module.exports = {
  esc, tallyDate, tag, tagAll,
  post, send, companies, testConnection,
  importEnvelope, voucherEnvelope, readImportReply
};
