/* ============================================================
   VOICE — listening and speaking, and nothing else

   Deliberately knows nothing about the assistant, the shop, or any
   business data. It turns speech into a string and a string into speech;
   what happens in between is the assistant's business, which is why this
   is a separate file and why the two can be reasoned about separately.

   THE BROWSER DOES BOTH JOBS. No audio is uploaded by this code, no key
   is needed, no provider is paid, and nothing is recorded or kept: the
   microphone stream is opened by the browser's own recognition, which
   ends it the moment it stops. What leaves the page is the TEXT, to the
   same /api/assistant/ask the typed box already uses.

   That is a real privacy property and not an accident of convenience.
   Sending audio to a transcription service would have meant a shop's
   conversations leaving the premises to be processed by a third party,
   and a shopkeeper would have had no way of knowing. The browser's
   recognition may itself use a network service — Chrome's does — which
   is why the screen says "your browser's speech recognition" rather than
   claiming the sound never leaves the machine.

   The pure helpers are defined first and exported for Node, so the parts
   that can be tested without a microphone are tested without one.
   ============================================================ */
var Voice = (function () {
  "use strict";

  /* Languages offered. English first because that is what has actually
     been tried; the others are here so adding one is a line rather than a
     rewrite, and they are NOT claimed to work until somebody has sat in a
     shop and used them. */
  var LANGS = [
    { code: "en-IN", label: "English (India)", tried: true },
    { code: "en-GB", label: "English (UK)", tried: false },
    { code: "hi-IN", label: "हिन्दी", tried: false },
    { code: "gu-IN", label: "ગુજરાતી", tried: false },
  ];

  /* ---------------------------------------------------------------- */
  /* PURE: what is worth saying out loud                               */
  /* ---------------------------------------------------------------- */

  /**
   * An answer, reduced to something a person would want read to them.
   *
   * Written answers carry things that are fine to look at and awful to
   * hear: a URL read character by character, a code fence, a row of
   * dashes from a table. They are taken out here rather than asked for in
   * the prompt, because a model that is told not to produce them still
   * sometimes does, and the one place this can be guaranteed is on the
   * way to the speaker.
   *
   * Long answers are cut at a SENTENCE, not at a character count — a
   * voice that stops halfway through a word sounds broken, and the whole
   * answer is on screen anyway.
   */
  function speakable(text, maxChars) {
    var limit = maxChars || 600;
    var s = String(text == null ? "" : text);

    s = s.replace(/```[\s\S]*?```/g, " ");        // fenced code
    s = s.replace(/`([^`]*)`/g, "$1");            // inline code ticks
    s = s.replace(/https?:\/\/\S+/gi, " link ");  // never spell a URL out
    s = s.replace(/<[^>]+>/g, " ");               // stray markup
    s = s.replace(/[*_#>|]+/g, " ");              // markdown furniture
    s = s.replace(/[-–—]{2,}/g, " ");             // table rules
    s = s.replace(/\s+/g, " ").trim();

    if (s.length <= limit) return s;

    /* Back off to the last sentence that fits; if there is not one, the
       last word. Better a short answer than a severed one. */
    var cut = s.slice(0, limit);
    var stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    if (stop > limit * 0.5) return cut.slice(0, stop + 1).trim();
    var space = cut.lastIndexOf(" ");
    return (space > 0 ? cut.slice(0, space) : cut).trim() + "…";
  }

  /**
   * Is a transcript worth sending?
   *
   * Silence and a cough both arrive as a result, and sending them costs a
   * paid API call to be told nothing was asked.
   */
  function worthSending(transcript) {
    var t = String(transcript || "").trim();
    return t.length >= 2 && /[a-z0-9ऀ-ॿ઀-૿]/i.test(t);
  }

  /* ---------------------------------------------------------------- */
  /* THE BROWSER'S OWN MACHINERY                                        */
  /* ---------------------------------------------------------------- */

  function w() {
    return typeof window === "undefined" ? null : window;
  }

  function recogniser() {
    var g = w();
    if (!g) return null;
    return g.SpeechRecognition || g.webkitSpeechRecognition || null;
  }

  /** Can this browser listen at all? Asked before a microphone is drawn. */
  function canListen() {
    return !!recogniser();
  }

  /** Can it speak? Separate question — some browsers do one and not the other. */
  function canSpeak() {
    var g = w();
    return !!(g && g.speechSynthesis && typeof g.SpeechSynthesisUtterance === "function");
  }

  /* One session at a time, held here so a second press cannot start a
     second microphone while the first is still open. */
  var session = null;

  function listening() { return !!session; }

  /**
   * Listen once.
   *
   * onFinal fires AT MOST ONCE. Recognition can deliver a final result and
   * then fire onend, or deliver two results for one utterance; without the
   * guard that becomes two questions, two API calls and two answers for
   * one thing said.
   *
   * Returns a handle. cancel() releases the microphone.
   */
  function listen(opts) {
    var o = opts || {};
    var Rec = recogniser();
    if (!Rec) {
      if (o.onError) o.onError("unsupported");
      return null;
    }
    if (session) return session;          // already going; not an error

    var rec = new Rec();
    rec.lang = o.lang || "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    var done = false;
    function finish(text) {
      if (done) return;
      done = true;
      session = null;
      if (o.onFinal) o.onFinal(text);
    }

    rec.onresult = function (ev) {
      var finalText = "", partial = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else partial += r[0].transcript;
      }
      if (partial && o.onPartial) o.onPartial(partial.trim());
      if (finalText) finish(finalText.trim());
    };

    rec.onerror = function (ev) {
      if (done) return;
      done = true;
      session = null;
      /* The names are the spec's. Translated by the caller, which knows
         what the person was trying to do. */
      var kind = (ev && ev.error) || "failed";
      if (o.onError) o.onError(kind);
    };

    rec.onend = function () {
      /* Ended with nothing final — silence, or a stop. Reported so the
         screen can leave the listening state rather than spin for ever. */
      if (done) return;
      done = true;
      session = null;
      if (o.onError) o.onError("no-speech");
    };

    session = {
      cancel: function () {
        if (done) return;
        done = true;
        session = null;
        try { rec.abort(); } catch (e) { /* already gone */ }
        if (o.onCancel) o.onCancel();
      },
      /* Stop listening but KEEP whatever was heard — the button that means
         "I have finished talking", as opposed to "forget it". */
      stop: function () { try { rec.stop(); } catch (e) { /* already gone */ } },
    };

    try {
      rec.start();
    } catch (e) {
      done = true;
      session = null;
      if (o.onError) o.onError("failed");
      return null;
    }
    if (o.onStart) o.onStart();
    return session;
  }

  /** Release the microphone, wherever we are. Safe to call at any time. */
  function cancel() {
    if (session) session.cancel();
  }

  /* ---------------------------------------------------------------- */
  /* SPEAKING                                                           */
  /* ---------------------------------------------------------------- */

  var speaking = false;

  /**
   * Say it once.
   *
   * ALWAYS cancels whatever is already being said. Two answers talking
   * over each other is worse than either, and it happens the moment
   * somebody asks a second question before the first has finished.
   */
  function speak(text, opts) {
    var o = opts || {};
    var g = w();
    if (!canSpeak()) { if (o.onEnd) o.onEnd(); return false; }

    var said = speakable(text, o.maxChars);
    if (!said) { if (o.onEnd) o.onEnd(); return false; }

    try { g.speechSynthesis.cancel(); } catch (e) { /* nothing to stop */ }

    var u = new g.SpeechSynthesisUtterance(said);
    u.lang = o.lang || "en-IN";
    u.rate = 1;
    u.onstart = function () { speaking = true; if (o.onStart) o.onStart(); };
    u.onend = function () { speaking = false; if (o.onEnd) o.onEnd(); };
    u.onerror = function () {
      /* The written answer is already on screen, so a failure to speak is
         not a failure to answer and is not reported as one. */
      speaking = false;
      if (o.onEnd) o.onEnd();
    };

    try { g.speechSynthesis.speak(u); return true; }
    catch (e) { speaking = false; if (o.onEnd) o.onEnd(); return false; }
  }

  /** Silence immediately. */
  function hush() {
    var g = w();
    speaking = false;
    try { if (g && g.speechSynthesis) g.speechSynthesis.cancel(); } catch (e) { /* fine */ }
  }

  function isSpeaking() { return speaking; }

  /** Everything off. Called when the assistant closes or the page leaves. */
  function release() {
    cancel();
    hush();
  }

  return {
    LANGS: LANGS,
    speakable: speakable,
    worthSending: worthSending,
    canListen: canListen,
    canSpeak: canSpeak,
    listening: listening,
    listen: listen,
    cancel: cancel,
    speak: speak,
    hush: hush,
    isSpeaking: isSpeaking,
    release: release,
  };
})();

/* So the pure helpers can be tested in Node without a browser. */
if (typeof module !== "undefined" && module.exports) module.exports = Voice;
