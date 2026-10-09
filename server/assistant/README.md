# The Shop Manager assistant

Answers questions about **this shop's own records** — stock, bills,
customers — by looking them up and writing the answer from what came
back. It does not answer from the model's general knowledge, and it says
so when it cannot find something.

## Switching it on

Two things are needed.

**1. A key.** Either is fine:

| | |
|---|---|
| `ASSISTANT_API_KEY` | a Google AI Studio key, set on the server |
| nothing | it falls back to the key **Bill Scanning** already uses |

A shop that has set up Bill Scanning needs no second key. Set
`ASSISTANT_API_KEY` only to bill the two features separately.

`ASSISTANT_MODEL` overrides the model (default `gemini-3.8-flash`).

**Never put a key in the repository.** There is no `.env` file here and
none should be added; the host sets the variable, or the shop pastes the
key into Settings, where it is sealed by `secretBox`.

**2. The feature, sold.** `assistant` is a licence feature, like
`billscan`. The vendor grants it per shop in the licence panel. It is in
no package — every question costs a call to a paid API, so it is granted
deliberately rather than arriving switched on with a tier bought for
something else.

With no key the screen says so and explains what to do. Nothing crashes
and nothing else in the app is affected.

## How it is put together

```
public/js/app.js        openAssistant() — a sheet, like every other screen
server/routes/assistant.js   /status and /ask
server/assistant/provider.js the model, kept behind one file
server/assistant/tools.js    the only things it may look at
```

**Two turns, with the database in between.**

1. the question goes to the model with a catalogue of the tools *this
   person* is allowed to use. It replies with a tool name and arguments —
   nothing else.
2. the server decides whether that tool may run, runs it, and sends the
   rows back for an answer written from them.

The model never becomes trusted in between. It cannot write SQL, cannot
name a table, and cannot reach a connection. The only thing it can do is
say a name out of a list.

## Why it is safe

- **Every tool re-checks permissions** with `permissions.can()`, against
  the session — after the model has spoken, and regardless of what it
  asked for. A staff member without the ledger cannot reach the ledger by
  asking nicely, or by a product description that tells the model to.
- **Every tool is read-only.** A test asserts there is no `INSERT`,
  `UPDATE` or `DELETE` in `tools.js`.
- **Rows are capped** (`MAX_ROWS`), so "list everything" cannot become the
  customer book in a prompt.
- **Search text is escaped**, so a `%` typed into a search does not match
  every row.
- **One shop cannot see another.** Tools run inside the existing company
  scope; there is no company id in any argument.
- **The key stays on the server.** It is never sent to the browser, and
  `/status` is asserted not to leak it.
- **Errors are translated.** The provider's developer-facing message never
  reaches the shopkeeper, and no stack trace does either.

Retrieved records are treated as **data, not instructions** — stated in
the system prompt, but the actual protection is that the model has no
authority to act on them in the first place.

## What it will not do

- **No writes.** Nothing here creates, edits or deletes a record. Any
  future write action needs its own confirmation step and its own review.
- **No conversation history on disk.** The thread lives in one variable in
  the page and is forgotten when the sheet closes. Deliberate: what gets
  typed here is the shop's own trade, and a shared counter PC should not
  keep it. Each answer carries its own question, so nothing is lost.
- **No multilingual promise.** The model will often answer in the language
  it was asked in, but that has not been tested and is not claimed.

## Adding a tool

Add it to the array in `tools.js` with a `module` and `action` that exist
in `permissions.js`. It is then automatically permission-checked, offered
only to people who may use it, and covered by the existing tests. Do not
add one that writes without discussing the confirmation flow first.
