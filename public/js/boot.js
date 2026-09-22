/* ============================================================
   BEFORE ANYTHING IS DRAWN

   Two jobs that both have to happen before, and independently of,
   app.js. Lifted out of an inline <script> in index.html so the
   Content-Security-Policy can be script-src 'self' with no
   'unsafe-inline' — an inline block would have forced either a hash,
   which breaks whenever anybody edits a comment inside it, or
   'unsafe-inline', which switches off most of what a CSP is for.

   Still loaded as a BLOCKING script in the head, so the theme is set
   before the first frame. Still a SEPARATE file from app.js, because
   the splash net below exists precisely for the case where app.js does
   not run at all.
   ============================================================ */
/* The chosen colour, before anything is drawn.

   app.js reads the same remembered key, but it loads at the end of the
   body — so until now the first thing painted was always navy, and a shop
   on another colour watched their app change under them. The splash below
   would have done it most visibly of all. Duplicated here on purpose:
   four lines in the head are the only way to be right on the first frame. */
try {
  var t = localStorage.getItem("shopManagerAppTheme");
  if (t && t !== "navy-gold") document.documentElement.setAttribute("data-theme", t);
} catch (e) { /* private mode — the default is already correct */ }

/* THE SPLASH COMES DOWN NO MATTER WHAT.

   app.js takes it away as soon as there is something to show, and that is
   the path that runs every morning. This is the other one. It lives here,
   in the head, because a splash is the one piece of UI that can hide a
   fault instead of revealing it: if app.js fails to parse — a bad deploy,
   a half-cached file — nothing inside app.js runs, including its own
   safety net, and the shop is left looking at a logo that never leaves,
   with the login sitting underneath it the whole time.

   Eight seconds, deliberately longer than the app's own six, so on a
   healthy-but-slow start it is app.js that clears the screen and this
   never fires. */
setTimeout(function () {
  var el = document.getElementById("splash");
  if (!el || el.dataset.going) return;
  el.dataset.going = "1";
  el.classList.add("is-done");
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
}, 8000);
