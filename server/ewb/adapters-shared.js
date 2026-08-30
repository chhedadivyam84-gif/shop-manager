/* The result shape every e-way bill adapter returns.
 *
 * In its own file because adapters.js holds the registry and the registry
 * has to require each adapter — so an adapter requiring these back from
 * adapters.js would be a cycle. Two tiny functions, no dependencies, and
 * both sides can require them freely.
 *
 * The shape matters more than the functions: callers must never have to
 * branch on which provider answered, so a mock failure and a real one
 * arrive looking identical.
 */

/** Success. `raw` keeps the provider's own answer for the log. */
function ok(data, raw) { return { ok: true, data, raw }; }

/**
 * Failure.
 *
 * `message` is shown to a shopkeeper, so it carries the provider's own
 * words wherever there are any — somebody can act on "invalid username or
 * password" and can do nothing at all with "authentication failed".
 *
 * `field` names the credential at fault where one is identifiable, so the
 * screen can point at the box to fix rather than the whole form.
 */
function fail(code, message, field, raw) {
  return { ok: false, error: { code, message, field: field || null }, raw };
}

module.exports = { ok, fail };
