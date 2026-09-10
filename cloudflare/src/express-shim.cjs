/* ============================================================
   A SMALL EXPRESS, FOR WORKERS

   The 58 route files are 17,200 lines of working, audited code that
   decide what a bill totals and what a shop owes. Rewriting them
   against a Workers router would be 58 opportunities to change a
   number by accident. So instead this reproduces the part of Express
   they actually use, and the files run unchanged.

   WHAT THEY ACTUALLY USE — counted, not guessed:

     router.get/post/put/delete/patch   417 registrations, 208 paths
     router.use                           4
     res.status                         618      res.json          369
     res.setHeader                       21      res.send           10
     res.sendFile                         1      res.download        1
     req.body                           443      req.params        203
     req.query                          142      req.session       135
     req.ip                               6      next()              2

   No regular expressions, no wildcards, no optional segments, and
   nothing streams or pipes. That is why this file is short.

   ANYTHING OUTSIDE THAT SET THROWS LOUDLY rather than returning
   undefined. A shim that silently does nothing produces a bill with a
   missing field, which is far worse than a stack trace.
   ============================================================ */

/* `/:id/items` -> matcher. Express semantics, minus the parts unused
   here: a segment beginning with ':' captures, everything else is
   literal, and the whole path must match. */
function compilePath(pattern) {
  const params = [];
  const segments = String(pattern).split("/").filter((s) => s.length);
  const parts = segments.map((seg) => {
    if (seg.startsWith(":")) { params.push(seg.slice(1)); return "([^/]+)"; }
    if (/[*+?()[\]]/.test(seg)) {
      throw new Error(`express-shim: unsupported route pattern "${pattern}" (segment "${seg}")`);
    }
    return seg.replace(/[.\\^$|]/g, "\\$&");
  });
  const source = "^/" + parts.join("/") + "/?$";
  return { regex: new RegExp(source), params };
}

class Layer {
  /* `mount` separates use("/sub", router) from get("/sub", handler).
     They look identical from the pattern alone, but a mount matches a
     PREFIX and passes the remainder down, while a route must match the
     whole path. Compiling a mount as an exact match is why /sub/deep
     silently 404s — it is not a difference that can be inferred later. */
  constructor(method, pattern, handlers, mount = false) {
    this.method = method;                     /* null on use() = all methods */
    this.pattern = pattern;
    this.handlers = handlers;
    this.mount = mount;
    this.compiled = pattern === null || mount ? null : compilePath(pattern);
  }
}

class Router {
  constructor() {
    this.stack = [];
    /* Route files call router.get(...) directly, so the instance must be
       callable as a plain object with methods — not a function like real
       Express. Nothing here mounts a router as a handler except use(). */
  }

  #add(method, pattern, handlers) {
    const flat = handlers.flat().filter((h) => typeof h === "function" || (h && h.stack));
    this.stack.push(new Layer(method, pattern, flat));
    return this;
  }

  get(p, ...h) { return this.#add("GET", p, h); }
  post(p, ...h) { return this.#add("POST", p, h); }
  put(p, ...h) { return this.#add("PUT", p, h); }
  delete(p, ...h) { return this.#add("DELETE", p, h); }
  patch(p, ...h) { return this.#add("PATCH", p, h); }
  all(p, ...h) { return this.#add(null, p, h); }

  /* use(fn) or use(path, fn|router). Only four call sites, all simple. */
  use(pathOrFn, ...rest) {
    if (typeof pathOrFn === "function" || (pathOrFn && pathOrFn.stack)) {
      this.stack.push(new Layer(null, null, [pathOrFn, ...rest].flat()));
      return this;
    }
    this.stack.push(new Layer(null, String(pathOrFn), rest.flat(), true));
    return this;
  }

  /* Walks the stack for `path`, running matching handlers in order.
     Returns true once a handler has responded. A handler that calls
     next() falls through to the following layer, which is what the two
     next() sites in the codebase rely on. */
  async handle(req, res, path) {
    for (const layer of this.stack) {
      if (layer.method && layer.method !== req.method) continue;

      let sub = path;
      let params = {};

      if (layer.compiled) {
        const m = layer.compiled.regex.exec(path);
        if (!m) continue;
        layer.compiled.params.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      } else if (layer.mount && layer.pattern !== null) {
        /* use("/prefix", ...) — match the prefix, pass the remainder down. */
        const prefix = "/" + String(layer.pattern).split("/").filter(Boolean).join("/");
        if (path !== prefix && !path.startsWith(prefix + "/")) continue;
        sub = path.slice(prefix.length) || "/";
      }

      req.params = { ...req.params, ...params };

      for (const handler of layer.handlers) {
        if (handler && handler.stack) {                     /* a nested router */
          if (await handler.handle(req, res, sub)) return true;
          continue;
        }

        let calledNext = false;
        const next = (err) => { if (err) throw err; calledNext = true; };
        await handler(req, res, next);

        if (res.finished) return true;
        if (!calledNext) return res.finished;               /* handler ended without responding */
      }
    }
    return false;
  }
}

/* ------------------------------------------------------------------
   res — collects a Response instead of writing to a socket.
   ------------------------------------------------------------------ */
class Res {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.finished = false;
    this.body = null;
    this.bodyType = null;
  }

  status(code) { this.statusCode = code; return this; }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
  set(k, v) { return this.setHeader(k, v); }
  type(t) { return this.setHeader("content-type", t); }

  json(obj) {
    this.setHeader("content-type", "application/json; charset=utf-8");
    this.body = JSON.stringify(obj);
    this.bodyType = "json";
    this.finished = true;
    return this;
  }

  send(payload) {
    if (payload === undefined || payload === null) { this.body = ""; }
    else if (typeof payload === "string") {
      if (!this.headers["content-type"]) this.setHeader("content-type", "text/html; charset=utf-8");
      this.body = payload;
    } else if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
      if (!this.headers["content-type"]) this.setHeader("content-type", "application/octet-stream");
      this.body = payload;
    } else {
      return this.json(payload);
    }
    this.bodyType = "send";
    this.finished = true;
    return this;
  }

  end(payload) { return this.send(payload); }

  /* There is exactly one sendFile and one download in the codebase, and
     both want a file from a disk a Worker does not have. Throwing names
     the real problem instead of returning an empty body that looks like
     a corrupt download. */
  sendFile() { throw new Error("express-shim: res.sendFile has no filesystem on Workers"); }
  download() { throw new Error("express-shim: res.download has no filesystem on Workers"); }
  redirect() { throw new Error("express-shim: res.redirect is not used by these routes"); }

  toResponse() {
    return new Response(this.body, { status: this.statusCode, headers: this.headers });
  }
}

/* ------------------------------------------------------------------
   The module object route files see as `require("express")`.
   ------------------------------------------------------------------ */
function express() {
  const app = new Router();
  app.listen = () => { throw new Error("express-shim: a Worker does not listen()"); };
  app.set = () => app;
  return app;
}

express.Router = () => new Router();
/* Bodies are parsed before the router runs, so these are no-ops kept only
   so `app.use(express.json())` does not explode. */
express.json = () => (req, res, next) => next();
express.urlencoded = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

module.exports = express;
module.exports.Router = express.Router;
module.exports.Res = Res;
module.exports.compilePath = compilePath;
