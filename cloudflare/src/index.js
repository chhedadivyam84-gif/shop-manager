/* ============================================================
   THE FRONT DOOR

   Serves the real frontend from public/ and answers the API. Everything
   stateful lives in the shop's Durable Object.

   DONE: the database layer, authentication, and the auth API the login
   screen actually calls — /mode, /staff-list, /session, /login, /logout.
   The paths and response SHAPES are copied from server/routes/auth.js,
   not invented, because public/js/app.js reads specific fields off them
   and a near-miss produces a login screen that renders and then does
   nothing.

   NOT DONE: the other 57 route files. The app will load and sign you in;
   it cannot yet write a bill.
   ============================================================ */
import {
  readSession, signSession, parseCookies, sessionCookie, clearCookie,
  COOKIE_NAME, hasRole, refusalFor,
} from "./auth.js";

export { ShopTenant } from "./tenant-do.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

function tenantFrom(url, env) {
  const host = url.hostname;
  const parts = host.split(".");

  /* Preferred once a custom domain exists: a subdomain per shop. workers.dev
     cannot do this — it gives one subdomain per Worker, not a wildcard. */
  if (env.TENANT_HOST_SUFFIX && host.endsWith(env.TENANT_HOST_SUFFIX) && parts.length > 2) {
    return parts[0];
  }

  /* Otherwise the shop is named in the query string, with DEFAULT_TENANT as
     the fallback so a person opening the bare URL lands somewhere real
     rather than on an error. This is not the access boundary: the session
     cookie is signed over tenant AND session id, so a cookie minted for one
     shop is refused by another. Naming a shop is not being let into it. */
  return url.searchParams.get("shop") || env.DEFAULT_TENANT || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* ---------- static frontend ----------
       Anything that is not an API call is the app itself: index.html, the
       26,947-line app.js, the stylesheet, the vendor bundles. Served
       straight from Workers Assets, which is why the vanilla-JS frontend
       survives this move essentially untouched. */
    if (!path.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "no asset binding configured" }, 500);
    }

    if (!env.SESSION_SECRET) {
      /* Fail closed: without a signing secret every cookie would be
         forgeable, which is worse than being down. */
      return json({ error: "SESSION_SECRET is not configured" }, 503);
    }

    const shop = tenantFrom(url, env);
    if (!shop) return json({ error: "could not determine which shop" }, 400);
    const stub = env.TENANT.getByName(shop);

    /* ---------- resolve the session ---------- */
    const cookies = parseCookies(request);
    const signed = await readSession(cookies[COOKIE_NAME], env.SESSION_SECRET);
    let session = null;
    let sid = null;
    if (signed && signed.tenant === shop) {
      sid = signed.sid;
      session = await stub.getSession(sid);
    }

    /* ================= auth API =================
       Shapes match server/routes/auth.js exactly. */

    /* Single-shop-per-URL for now, so multiTenant is false: the shop is
       decided by the address, and staff sign straight in with a PIN. Saying
       true here would send the login screen looking for a shop sign-in stage
       that does not exist yet. */
    if (path === "/api/auth/mode") {
      return json({ multiTenant: false, canSignInAsShop: false, shop: null });
    }

    /* Returns a BARE ARRAY, as the Express route does. Wrapping it in an
       object is the kind of near-miss that renders an empty staff picker. */
    if (path === "/api/auth/staff-list") {
      return json(await stub.listStaff());
    }

    if (path === "/api/auth/session") {
      const info = await stub.shopInfo();
      return json({
        loggedIn: !!session,
        businessName: info.businessName,
        logo: info.logo,
        staffName: session ? session.staffName : null,
        role: session ? session.role : null,
        featuresOff: [],
        multiTenant: false,
        sellBuild: false,
      });
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "body must be JSON" }, 400); }

      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const result = await stub.login(body.staffId, body.pin, ip);
      if (!result.ok) return json({ error: result.error }, result.status);

      const cookie = await signSession(shop, result.sid, env.SESSION_SECRET);
      return json(
        { ok: true, businessName: result.businessName, staffName: result.staffName, role: result.role },
        200,
        { "set-cookie": sessionCookie(cookie, 30 * 24 * 60 * 60) }
      );
    }

    if (path === "/api/auth/logout" && request.method === "POST") {
      if (sid) await stub.destroySession(sid);
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    /* ---------- migration intake ----------
       Gated on a secret that exists only while a migration is running and
       is deleted afterwards. Without it these routes do not exist at all
       rather than existing in a permissive state. */
    const migrationOk = env.MIGRATION_TOKEN &&
      request.headers.get("x-migration-token") === env.MIGRATION_TOKEN;

    if (path === "/api/migrate/import" || path === "/api/migrate/select" ||
        path === "/api/migrate/reset"  || path === "/api/migrate/rows" ||
        path === "/api/migrate/backup" || path === "/api/migrate/legacy") {
      if (!env.MIGRATION_TOKEN) return json({ error: "migration is not enabled" }, 404);
      if (!migrationOk) return json({ error: "bad token" }, 403);
      if (request.method !== "POST") return json({ error: "POST only" }, 405);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "body must be JSON" }, 400); }

      try {
        /* Counts live here rather than on /api/rows because the verifier runs
           before anyone has logged in — the migration is what puts the staff
           table there in the first place. */
        if (path === "/api/migrate/rows") return json({ counts: await stub.rowCounts() });
        if (path === "/api/migrate/backup") return json(await stub.backupNow("migration", shop));

        /* Inspect the pre-existing shop-backups bucket. Listing only — this
           never writes to it, because whatever is in there predates today
           and may be the only copy of something. */
        if (path === "/api/migrate/legacy") {
          if (!env.LEGACY_BACKUPS) return json({ error: "not bound" }, 500);
          const page = await env.LEGACY_BACKUPS.list({
            limit: body.limit || 100, cursor: body.cursor, prefix: body.prefix,
          });
          return json({
            truncated: page.truncated,
            cursor: page.truncated ? page.cursor : null,
            objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
          });
        }
        if (path === "/api/migrate/reset") return json(await stub.clearAllRows(body.tables));
        if (path === "/api/migrate/select") return json({ rows: await stub.selectRows(body.table, body.limit) });
        return json(await stub.importTable(body.table, body.rows));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    /* Development only, and structurally so: the deployed Worker sets
       ENVIRONMENT=production, so this cannot exist on the live URL. */
    if (path === "/api/dev/seed-staff" && env.ENVIRONMENT !== "production") {
      const body = await request.json().catch(() => ({}));
      return json(await stub.devSeedStaff(body.name, body.pin, body.role));
    }

    /* ================= past here needs a login ================= */
    if (!session) return json({ error: "Not logged in" }, 401);

    if (path === "/api/health") return json({ shop, ...(await stub.health()) });

    if (path === "/api/rows") {
      if (!hasRole(session, "owner")) return json({ error: refusalFor(["owner"]) }, 403);
      return json({ shop, counts: await stub.rowCounts() });
    }

    /* ---------- backups ----------
       Owner-only, matching server/routes/backup.js, where the cloud
       listing and deletion are both behind requireRole("owner"). */
    if (path === "/api/backup" || path.startsWith("/api/backup/")) {
      if (!hasRole(session, "owner")) return json({ error: refusalFor(["owner"]) }, 403);

      if (path === "/api/backup" || path === "/api/backup/status") {
        return json(await stub.backupStatus(shop));
      }
      if (path === "/api/backup/run" && request.method === "POST") {
        return json(await stub.backupNow("manual", shop));
      }
      if (path === "/api/backup/restore" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.key) return json({ error: "which backup? pass { key }" }, 400);
        try { return json(await stub.restoreFromBackup(body.key, body.tables)); }
        catch (e) { return json({ error: String(e.message || e) }, 500); }
      }
      return json({ error: "not found" }, 404);
    }

    /* ---------- everything else is the real app ----------
       The 57 route files run inside the Durable Object, where the database
       is. The Worker's job is only to turn an HTTP request into something
       the Express shim understands and turn the answer back. */
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const type = request.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        try { body = await request.json(); }
        catch { return json({ error: "Body must be valid JSON." }, 400); }
      } else if (type) {
        /* Nothing in these routes reads a non-JSON body, so accepting one
           silently would mean req.body is {} and a field goes missing
           without anyone noticing. */
        return json({ error: `Unsupported content-type: ${type}` }, 415);
      }
    }

    const query = Object.fromEntries(url.searchParams.entries());
    delete query.shop;               /* routing detail, not a route's parameter */

    const result = await stub.apiRequest({
      method: request.method,
      path,
      query,
      body,
      session,
      tenant: shop,
      ip: request.headers.get("cf-connecting-ip") || "unknown",
      headers: Object.fromEntries(request.headers),
    });

    return new Response(result.body, { status: result.status, headers: result.headers });
  },
};
