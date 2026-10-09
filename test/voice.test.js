/* ============================================================
   THE VOICE ASSISTANT — what can be tested without a microphone

   A microphone cannot be driven from a test, and a synthesised voice
   cannot be listened to by one. What CAN be checked is everything
   around them, and that turns out to be most of what goes wrong:

     · an answer read aloud with a URL spelled out character by character
     · one spoken question becoming two API calls, because recognition
       fired a result AND an end event
     · a second microphone opening behind the first
     · two answers talking over each other
     · a microphone still open after the screen was closed

   None of those need a microphone to reproduce. They need a fake one,
   which is what this file brings — a SpeechRecognition that can be told
   to deliver a result, fail, or go quiet, and a speechSynthesis that
   records what it was asked to say.

   Run:  node test/voice.test.js
   ============================================================ */
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

/* ------------------------------------------------------------------ */
/* A browser, roughly                                                  */
/* ------------------------------------------------------------------ */

let LAST_REC = null;          // the most recently constructed recogniser
let SPOKEN = [];              // every utterance handed to the synthesiser
let CANCELS = 0;              // how many times speech was cancelled

function FakeRecognition() {
  this.lang = ""; this.interimResults = false; this.continuous = false;
  this.started = false; this.aborted = false; this.stopped = false;
  LAST_REC = this;
}
FakeRecognition.prototype.start = function () { this.started = true; };
FakeRecognition.prototype.abort = function () { this.aborted = true; };
FakeRecognition.prototype.stop = function () { this.stopped = true; };
/* What the browser would do when it heard something. */
FakeRecognition.prototype.hear = function (text, isFinal) {
  this.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: !!isFinal }] });
};
FakeRecognition.prototype.die = function (kind) { this.onerror({ error: kind }); };
FakeRecognition.prototype.finish = function () { this.onend(); };

function FakeUtterance(text) { this.text = text; SPOKEN.push(text); }

function installBrowser(opts) {
  const o = opts || {};
  global.window = {
    SpeechRecognition: o.noListen ? undefined : FakeRecognition,
    speechSynthesis: o.noSpeak ? undefined : {
      cancel() { CANCELS++; },
      speak(u) { if (u.onstart) u.onstart(); },
    },
    SpeechSynthesisUtterance: o.noSpeak ? undefined : FakeUtterance,
  };
}
function removeBrowser() { delete global.window; }

/* Loaded AFTER the fakes exist is not required — voice.js looks at
   window when it is called, not when it is loaded, which is itself worth
   knowing and is why this works at all. */
const Voice = require(path.join(ROOT, "public/js/voice.js"));

(function () {
  /* ---------------------------------------------------------------- */
  console.log("\n--- what is worth saying out loud ---\n");

  ok("a plain answer is left alone",
     Voice.speakable("You have 9 sheets of 8x4 left.") === "You have 9 sheets of 8x4 left.");

  ok("a URL is never spelled out",
     !/https/.test(Voice.speakable("See https://example.com/a/b?c=1 for more")),
     Voice.speakable("See https://example.com/a/b?c=1 for more"));

  ok("a fenced code block is not read aloud",
     !/SELECT/.test(Voice.speakable("Here:\n```\nSELECT * FROM products\n```\ndone")),
     Voice.speakable("Here:\n```\nSELECT * FROM products\n```\ndone"));

  ok("markdown furniture is dropped",
     Voice.speakable("**Low stock:** *two* items") === "Low stock: two items",
     Voice.speakable("**Low stock:** *two* items"));

  ok("a row of table dashes is not read as noise",
     !/--/.test(Voice.speakable("Name | Stock\n----- | -----\nPly | 9")));

  ok("stray markup goes",
     Voice.speakable("<b>9</b> sheets") === "9 sheets", Voice.speakable("<b>9</b> sheets"));

  const long = "This is a sentence. " .repeat(60);
  const cut = Voice.speakable(long, 100);
  ok("a long answer is cut short", cut.length <= 101, cut.length);
  ok("...at the end of a SENTENCE, not mid-word", /\.$|…$/.test(cut), cut.slice(-20));

  ok("an empty answer is empty, not the word undefined", Voice.speakable(null) === "");

  /* ---------------------------------------------------------------- */
  console.log("\n--- what is worth sending ---\n");

  ok("silence is not a question", Voice.worthSending("") === false);
  ok("a space is not a question", Voice.worthSending("   ") === false);
  ok("one letter is not a question", Voice.worthSending("a") === false);
  ok("punctuation alone is not a question", Voice.worthSending("...") === false);
  ok("a real question is", Voice.worthSending("how much ply is left") === true);

  /* ---------------------------------------------------------------- */
  console.log("\n--- a browser that cannot do it ---\n");

  removeBrowser();
  ok("without a browser it does not claim it can listen", Voice.canListen() === false);
  ok("...nor speak", Voice.canSpeak() === false);

  installBrowser({ noListen: true });
  ok("a browser with no recognition cannot listen", Voice.canListen() === false);
  let told = null;
  const none = Voice.listen({ onError: k => { told = k; } });
  ok("...and asking it to says so rather than throwing", told === "unsupported", told);
  ok("...and starts nothing", none === null);

  installBrowser({ noSpeak: true });
  ok("a browser with no synthesis cannot speak", Voice.canSpeak() === false);
  let ended = false;
  const said = Voice.speak("anything", { onEnd: () => { ended = true; } });
  ok("...and speak() reports it did not", said === false);
  ok("...but still finishes, so a screen is not left waiting", ended === true);

  /* ---------------------------------------------------------------- */
  console.log("\n--- listening ---\n");

  installBrowser();
  SPOKEN = []; CANCELS = 0;

  let partials = [], finals = [], errors = [];
  Voice.listen({
    lang: "en-IN",
    onPartial: t => partials.push(t),
    onFinal: t => finals.push(t),
    onError: k => errors.push(k),
  });
  ok("the microphone was started", LAST_REC && LAST_REC.started === true);
  ok("...in the language asked for", LAST_REC.lang === "en-IN", LAST_REC.lang);
  ok("...and it reports itself as listening", Voice.listening() === true);

  LAST_REC.hear("how much ply", false);
  ok("a part-heard phrase is reported as it arrives", partials[0] === "how much ply", partials);

  LAST_REC.hear("how much ply is left", true);
  ok("the finished phrase comes through once", finals.length === 1, finals);
  ok("...with the whole sentence", finals[0] === "how much ply is left", finals);
  ok("...and the microphone is released", Voice.listening() === false);

  /* THE ONE THAT CAUSES TWO BILLS FOR ONE QUESTION. */
  LAST_REC.finish();
  LAST_REC.hear("how much ply is left", true);
  ok("A SECOND RESULT AFTER THE FIRST IS IGNORED", finals.length === 1, finals);
  ok("...and no spurious error is raised either", errors.length === 0, errors);

  /* ---------------------------------------------------------------- */
  console.log("\n--- one microphone at a time ---\n");

  const first = Voice.listen({ onFinal(){}, onError(){} });
  const firstRec = LAST_REC;
  const second = Voice.listen({ onFinal(){}, onError(){} });
  ok("a second press does not open a second microphone", LAST_REC === firstRec);
  ok("...it returns the session already running", second === first);

  Voice.cancel();
  ok("cancelling aborts the recogniser", firstRec.aborted === true);
  ok("...and nothing is listening afterwards", Voice.listening() === false);

  /* ---------------------------------------------------------------- */
  console.log("\n--- when listening goes wrong ---\n");

  const kinds = ["not-allowed", "no-speech", "audio-capture", "network"];
  const got = [];
  for (const k of kinds) {
    Voice.listen({ onFinal(){}, onError: e => got.push(e) });
    LAST_REC.die(k);
  }
  ok("every failure is reported by name, for the screen to translate",
     JSON.stringify(got) === JSON.stringify(kinds), got);
  ok("...and none of them leaves a microphone open", Voice.listening() === false);

  Voice.listen({ onFinal(){}, onError: e => got.push(e) });
  LAST_REC.finish();
  ok("ending with nothing heard is reported, not left spinning",
     got[got.length - 1] === "no-speech", got[got.length - 1]);

  /* ---------------------------------------------------------------- */
  console.log("\n--- speaking ---\n");

  installBrowser();
  SPOKEN = []; CANCELS = 0;

  Voice.speak("You have 9 sheets left.");
  ok("it says the answer", SPOKEN.length === 1 && SPOKEN[0] === "You have 9 sheets left.", SPOKEN);
  ok("...and reports that it is speaking", Voice.isSpeaking() === true);

  /* TWO ANSWERS TALKING OVER EACH OTHER. */
  const before = CANCELS;
  Voice.speak("And 3 of the other size.");
  ok("A SECOND ANSWER SILENCES THE FIRST", CANCELS === before + 1, { before, CANCELS });
  ok("...and only the new one is spoken", SPOKEN.length === 2, SPOKEN);

  Voice.hush();
  ok("stop speaking stops it", Voice.isSpeaking() === false);

  SPOKEN = [];
  Voice.speak("   ");
  ok("an empty answer is not announced", SPOKEN.length === 0, SPOKEN);

  /* ---------------------------------------------------------------- */
  console.log("\n--- letting go of everything ---\n");

  Voice.listen({ onFinal(){}, onError(){} });
  const open = LAST_REC;
  Voice.speak("still talking");
  const cancelsBefore = CANCELS;

  Voice.release();
  ok("release aborts the microphone", open.aborted === true);
  ok("...silences the answer", CANCELS > cancelsBefore);
  ok("...and leaves nothing listening", Voice.listening() === false);
  ok("...or speaking", Voice.isSpeaking() === false);

  /* ---------------------------------------------------------------- */
  console.log("\n--- no audio is uploaded by this code ---\n");

  const src = require("fs").readFileSync(path.join(ROOT, "public/js/voice.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("voice.js makes no network request of its own",
     !/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(src));
  ok("...and never touches getUserMedia or a recorder",
     !/getUserMedia|MediaRecorder/.test(src));

  removeBrowser();
  console.log(`\n==============================================`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`==============================================\n`);
  process.exitCode = fail ? 1 : 0;
})();
