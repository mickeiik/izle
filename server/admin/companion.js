// @ts-check
// "Listen along": this phone plays another source of the episode the TV is playing, in sync with the picture. The
// maths live in lib.js and the stream in companion-player.js; this module owns the card, the long-poll that follows
// the TV and the 250 ms correction loop. A channel has no timeline to follow: the card says so and offers nothing.

import { api, attempt, devicePath, isUnauthorized, readStored, writeStored } from "./api.js";
import { attach, nativeHlsBroken } from "./companion-player.js";
import { actionButton, card, h, slot, toast } from "./dom.js";
import { SYNC, candidateOptions, clockOffset, companionTarget, errorText, formatDrift, formatPosition, isActive, parseCandidate, plural, syncDecision, tvPositionAt } from "./lib.js";

const NUDGE_KEY = "izle.companion.nudgeMs";
const TICK_MS = 250;
const LONG_POLL_SEC = 25;
const CLOCK_SAMPLE_MS = 60_000;
/** Stop listening when the TV has not reported for this long. */
const IDLE_STOP_MS = 2 * 60_000;
/** After a seek the player settles before the error is judged again; it seeks a little ahead (the seek takes time). */
const SEEK_HOLD_MS = 1000;
const SEEK_LEAD_MS = 150;
const RE_RESOLVE_BEFORE_EXPIRY_MS = 60_000;
const MAX_RECOVERIES = 3;
const SWITCHED = "The TV switched to a channel; listening ended.";

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} episodeId @param {string} sourceId */
const linkPath = (episodeId, sourceId) => `/companion/links/${encodeURIComponent(episodeId)}/${encodeURIComponent(sourceId)}`;

/**
 * The "Listen along" card; `stop` ends listening (when the owner leaves the page, whose `signal` cancels the reads).
 * @param {{ deviceId: string, signal: AbortSignal }} o @returns {import("./view-device.js").Section & { stop(): void }}
 */
export function companionCard({ deviceId, signal }) {
  const base = devicePath(deviceId);
  const choiceKey = (/** @type {string} */ itemId) => `izle.companion.choice.${deviceId}.${itemId}`;

  /** @type {any} the last /companion answer */
  let candidates = null;
  let candidatesKey = "";
  let phase = /** @type {"idle" | "starting" | "listening"} */ ("idle");
  /** @type {{ episodeId: string, sourceId: string, language: string | null, link: import("./lib.js").LinkTiming, expiresAt: string | null, transport: string } | null} */
  let playing = null;
  let stream = /** @type {import("./companion-player.js").Attached | null} */ (null);
  let anchor = /** @type {import("./lib.js").Anchor | null} */ (null);
  let tvActive = false;
  let lastActiveAt = Date.now();
  let seq = 0;
  let samples = /** @type {import("./lib.js").ClockSample[]} */ ([]);
  let offset = /** @type {number | null} */ (null);
  let bestRtt = Infinity;
  let nudgeMs = Number(readStored(NUDGE_KEY) ?? 0) || 0;
  let seekHoldUntil = 0;
  let recoveries = 0;
  let lastReResolveAt = 0;
  /** Bumped by stop() and by every load(): work that awaited across one drops its result. */
  let generation = 0;
  let loadSeq = 0;
  let loopTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined);
  let clockTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined);
  let poll = /** @type {AbortController | null} */ (null);

  const audio = /** @type {HTMLAudioElement} */ (h("audio", { preload: "auto", playsinline: true }));
  const select = h("select", { id: "cp-source" });
  const offsetInput = h("input", { type: "number", id: "cp-offset", step: "0.001", inputmode: "decimal" });
  const rateInput = h("input", { type: "number", id: "cp-rate", step: "0.0001", min: "0.5", max: "2", inputmode: "decimal" });
  const save = actionButton("Save timing", null, () => saveTiming());
  const applyAll = actionButton("Apply to all episodes", null, () => applyToAll());
  const listen = h("button", { type: "button", class: "primary" }, "Listen");
  const startAudio = h("button", { type: "button", class: "primary", hidden: true }, "Start audio");
  const nudgeText = h("span");
  const status = h("p", { class: "muted status" });
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const body = slot();
  const nothing = h("p", { class: "muted" }, "The TV is not playing anything right now.");
  const channel = h("p", { class: "muted" });

  const nudge = (/** @type {number} */ delta) => {
    nudgeMs += delta;
    writeStored(NUDGE_KEY, String(nudgeMs));
    nudgeText.textContent = `nudge ${formatDrift(nudgeMs)}`;
  };
  nudge(0);

  const timing = h("div", { class: "timing" }, h("div", null, h("label", { for: "cp-offset" }, "Offset (seconds)"), offsetInput), h("div", null, h("label", { for: "cp-rate" }, "Speed"), rateInput));
  const timingHint = h("p", { class: "hint" }, "Offset: where the companion is when the TV is at 0:00 (negative when it starts earlier). Speed: companion seconds per TV second, e.g. 1.0427 for a PAL transfer against a film-rate source. Changes apply while you listen; Save keeps them.");
  const nudgeRow = h("div", { class: "nudge" }, h("button", { type: "button", onclick: () => nudge(-50) }, "−50 ms"), nudgeText, h("button", { type: "button", onclick: () => nudge(50) }, "+50 ms"), h("span", { class: "hint" }, "for your earphones' delay; remembered on this phone"));
  const form = h("div", { class: "companion" }, h("label", { for: "cp-source" }, "Audio on this phone"), select, timing, timingHint, h("div", { class: "actions" }, save, applyAll), h("div", { class: "actions" }, listen, startAudio), nudgeRow, status, error, audio);
  const element = card({ title: "Listen along", intro: "Hear another source of what the TV is playing, on this phone, in sync with the picture. Plug in earphones first." }, body.element);

  const showError = (/** @type {string} */ text) => {
    error.textContent = text;
    error.hidden = !text;
  };

  const chosen = () => parseCandidate(select.value);

  const fillTiming = () => {
    const { sourceId } = chosen();
    const c = candidates?.candidates.find((/** @type {any} */ x) => x.sourceId === sourceId);
    const link = c?.link ?? { offsetMs: 0, rate: 1 };
    offsetInput.value = (link.offsetMs / 1000).toFixed(3);
    rateInput.value = String(link.rate);
  };

  /** The timing the inputs show, which the loop uses while listening. */
  const timingFromInputs = () => {
    const offsetSec = Number(offsetInput.value);
    const rate = Number(rateInput.value);
    if (!Number.isFinite(offsetSec) || !Number.isFinite(rate) || rate < 0.5 || rate > 2) return null;
    return { offsetMs: Math.round(offsetSec * 1000), rate };
  };

  const renderCandidates = () => {
    const n = candidates?.nowPlaying;
    if (!n) return body.show(nothing);
    if (n.itemKind === "live") {
      if (phase !== "idle") end(SWITCHED, "info");
      channel.textContent = `“${n.itemTitle ?? n.itemId}” is a channel. Listen along is not available for a channel: it has no timeline to follow.`;
      return body.show(channel);
    }
    const options = candidateOptions(candidates.candidates);
    const remembered = readStored(choiceKey(n.itemId));
    const current = select.value || remembered || options.find((o) => !o.disabled && o.sourceId !== n.sourceId)?.value || options[0]?.value || "";
    select.replaceChildren(...options.map((o) => h("option", { value: o.value, disabled: o.disabled, selected: o.value === current }, o.label)));
    if (!select.value && options[0]) select.value = options[0].value;
    applyAll.hidden = n.itemKind !== "series";
    if (phase === "idle") fillTiming();
    body.show(form);
  };

  /** Re-reads the candidates of what the TV plays and shows them when they changed (`force`: in any case). */
  const refresh = async (force = false) => {
    if (force) candidatesKey = "";
    const r = await api("GET", `${base}/companion`, undefined, { signal });
    // By item too: two channels have the same (null) episode id.
    const key = JSON.stringify([r.nowPlaying?.itemId, r.nowPlaying?.episodeId, r.nowPlaying?.sourceId, r.candidates.map((/** @type {any} */ c) => [c.sourceId, c.link])]);
    if (key === candidatesKey) return;
    candidatesKey = key;
    const episodeChanged = candidates?.nowPlaying?.itemId !== r.nowPlaying?.itemId || candidates?.nowPlaying?.episodeId !== r.nowPlaying?.episodeId;
    candidates = r;
    if (episodeChanged) select.value = "";
    renderCandidates();
  };

  select.addEventListener("change", () => {
    const n = candidates?.nowPlaying;
    if (n) writeStored(choiceKey(n.itemId), select.value);
    fillTiming();
    if (phase === "listening" && playing) {
      const { sourceId, language } = chosen();
      if (sourceId !== playing.sourceId || language !== playing.language) void restart();
    }
  });
  for (const input of [offsetInput, rateInput]) {
    input.addEventListener("input", () => {
      const t = timingFromInputs();
      if (t && playing) playing.link = t;
    });
  }

  const saveTiming = async () => {
    const n = candidates?.nowPlaying;
    const t = timingFromInputs();
    if (!n || !t) return toast("Offset or speed is not a valid number (speed 0.5–2).", "error");
    const { sourceId, language } = chosen();
    const r = await attempt(() => api("PUT", linkPath(n.episodeId, sourceId), { ...t, language }), "Timing saved for this episode.");
    if (r.ok) await refresh(true).catch(() => {});
  };
  const applyToAll = async () => {
    const n = candidates?.nowPlaying;
    if (!n) return;
    const r = await attempt(() => api("POST", `${linkPath(n.episodeId, chosen().sourceId)}/copy-to-item`));
    if (r.ok) toast(r.value.updated === 0 ? "No other episode has that source." : `Timing copied to ${plural(r.value.updated, "other episode")}.`);
  };

  const serverNow = () => Date.now() + (offset ?? 0);

  /** One `/now` call (with `wait`, a long-poll on `seq`), which keeps the clock offset fresh. */
  const readNow = async (/** @type {boolean} */ wait, /** @type {AbortSignal | undefined} */ signal) => {
    const sentAt = Date.now();
    const query = wait ? `?seq=${seq}&wait=${LONG_POLL_SEC}` : "?wait=0";
    const r = await api("GET", `${base}/now${query}`, undefined, { signal });
    const receivedAt = Date.now();
    const rtt = receivedAt - sentAt;
    if (!wait || rtt <= SYNC.sampleMaxRttMs) {
      samples = [...samples, { sentAt, receivedAt, serverNowMs: r.serverNowMs }].slice(-8);
      offset = clockOffset(samples);
      bestRtt = Math.min(bestRtt, rtt);
    }
    // Answers can cross (a clock sample next to the long-poll): only a newer row replaces the anchor.
    if (r.seq >= seq) {
      seq = r.seq;
      anchor = r.anchor;
      // "Active" means recent playback reports; the SSE flag (`online`) is about commands, not about playback.
      tvActive = isActive(r.nowPlaying, true);
      if (tvActive) lastActiveAt = Date.now();
    }
    return r;
  };

  const followLoop = async () => {
    const controller = (poll = new AbortController());
    while (!controller.signal.aborted) {
      try {
        const r = await readNow(true, controller.signal);
        if (playing && r.nowPlaying?.itemKind === "live") end(SWITCHED, "info");
        else if (playing && r.nowPlaying?.episodeId && r.nowPlaying.episodeId !== playing.episodeId) await follow(r.nowPlaying.episodeId);
        else if (Date.now() - lastActiveAt > IDLE_STOP_MS) end("The TV stopped; listening ended.", "info");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isUnauthorized(err)) return stop();
        await sleep(3000);
      }
    }
  };

  const detach = () => {
    stream?.destroy();
    stream = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };

  const playOrAsk = async () => {
    try {
      await audio.play();
      startAudio.hidden = true;
    } catch (err) {
      const name = /** @type {any} */ (err)?.name;
      // iOS needs play() inside a tap: offer a button whose handler calls it directly.
      if (name === "NotAllowedError") startAudio.hidden = false;
      // The source is attached but nothing is loaded yet: play once it can.
      else if (name === "NotSupportedError" && audio.currentSrc) audio.addEventListener("canplay", () => void audio.play().catch(() => {}), { once: true });
      // A pause() from the loop (the TV is not advancing) or a new load interrupted this play(): the next tick decides.
      else if (name !== "AbortError") throw err;
    }
  };
  startAudio.addEventListener("click", () => void playOrAsk().catch((err) => showError(String(err?.message ?? err))));

  /** Resolves and loads the chosen source for `episodeId` (the loop seeks); whether it took effect, not overtaken. */
  const load = async (/** @type {string} */ episodeId) => {
    if (phase === "idle") return false;
    const my = ++loadSeq;
    const gen = generation;
    const stale = () => my !== loadSeq || gen !== generation || phase === "idle";
    const { sourceId, language } = chosen();
    const r = await api("POST", `${base}/companion/resolve`, { episodeId, sourceId, language });
    if (stale()) return false;
    detach();
    const link = phase === "listening" && playing && playing.episodeId === episodeId ? playing.link : (timingFromInputs() ?? r.link);
    stream = await attach(audio, r.media, language, (what) => {
      showError(`Stream error (${what}).`);
      void recover();
    });
    if (stale()) {
      detach(); // Stop or a newer load won while the stream was being attached
      return false;
    }
    playing = { episodeId, sourceId, language, link, expiresAt: r.expiresAt ?? null, transport: stream.transport };
    seekHoldUntil = 0;
    const n = candidates?.nowPlaying;
    if ("mediaSession" in navigator && n) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: n.itemTitle ?? "izle", artist: n.episodeTitle ?? "Listen along" });
      } catch {
        // optional
      }
    }
    await playOrAsk();
    return true;
  };

  const recover = async () => {
    if (phase !== "listening" || !playing) return;
    if (++recoveries > MAX_RECOVERIES) return end("The companion stream keeps failing; listening ended.", "error");
    await sleep(2000);
    if (phase !== "listening" || !playing) return;
    try {
      if (await load(playing.episodeId)) {
        recoveries = 0;
        showError("");
      }
    } catch (err) {
      showError(errorText(err));
      void recover();
    }
  };
  audio.addEventListener("error", () => {
    if (phase !== "listening") return;
    if (playing?.transport === "native HLS") nativeHlsBroken(); // next attempt goes through hls.js
    showError("The phone could not play this stream.");
    void recover();
  });

  /** The TV moved to another episode: the same source and language there, with that episode's own timing. */
  const follow = async (/** @type {string} */ episodeId) => {
    const wanted = playing;
    if (!wanted) return;
    try {
      await refresh(true);
      if (phase !== "listening") return;
      const option = candidateOptions(candidates?.candidates ?? []).find((o) => o.sourceId === wanted.sourceId && o.language === wanted.language && !o.disabled);
      if (!option) return end("The next episode has no such source; listening ended.", "error");
      select.value = option.value;
      fillTiming(); // the new episode's own stored timing
      playing = null; // `load` then takes the timing from the inputs
      if (await load(episodeId)) recoveries = 0;
    } catch (err) {
      end(errorText(err), "error");
    }
  };

  const restart = async () => {
    const episodeId = candidates?.nowPlaying?.episodeId;
    if (!playing || !episodeId) return;
    playing = null;
    await load(episodeId).catch((err) => showError(errorText(err)));
  };

  const tick = () => {
    if (phase !== "listening" || !playing) return;
    const now = serverNow();
    const tvPos = tvPositionAt(anchor, now);
    if (tvPos === null) return;
    const target = companionTarget(tvPos, playing.link, nudgeMs);
    const actual = audio.currentTime * 1000;
    // The companion is shorter than the TV's cut: stay silent at its end instead of restarting from 0 on play().
    const pastEnd = Number.isFinite(audio.duration) && target >= audio.duration * 1000;
    const d = syncDecision({ targetMs: target, actualMs: actual, tvPlaying: Boolean(anchor?.playing) && tvActive && !pastEnd, nominalRate: playing.link.rate });
    if (pastEnd) d.state = "past the end";
    const settled = Date.now() >= seekHoldUntil;
    if (settled && d.action === "seek") {
      audio.currentTime = Math.max(0, (d.toMs ?? target) + SEEK_LEAD_MS) / 1000;
      seekHoldUntil = Date.now() + SEEK_HOLD_MS;
      if (audio.paused) void playOrAsk().catch(() => {});
    } else if (settled && d.action === "play") {
      if (audio.paused) void playOrAsk().catch(() => {});
      if (Math.abs(audio.playbackRate - d.rate) > 0.0005) audio.playbackRate = d.rate;
    } else if (settled && !audio.paused) audio.pause();

    const rtt = Number.isFinite(bestRtt) ? ` · clock ±${Math.round(bestRtt / 2)} ms` : "";
    status.textContent = `TV ${formatPosition(tvPos)} · phone ${formatPosition(actual)} · drift ${formatDrift(d.errorMs)} · ${d.state} · ${playing.transport}${rtt}`;
    status.classList.toggle("synced", d.state === "synced");
    // Re-resolve shortly before the stream's URL expires, at most once a minute (an adapter may always answer
    // with a short validity).
    if (playing.expiresAt && Date.parse(playing.expiresAt) - now < RE_RESOLVE_BEFORE_EXPIRY_MS && Date.now() - lastReResolveAt > RE_RESOLVE_BEFORE_EXPIRY_MS) {
      lastReResolveAt = Date.now();
      void load(playing.episodeId).catch(() => void recover());
    }
  };

  const start = async () => {
    const n = candidates?.nowPlaying;
    if (!n?.episodeId || phase !== "idle" || !chosen().sourceId) return;
    phase = "starting";
    const gen = generation;
    listen.textContent = "Stop";
    listen.className = "danger";
    showError("");
    status.textContent = "Starting…";
    [recoveries, lastReResolveAt, samples, offset, bestRtt, seq] = [0, 0, [], null, Infinity, 0];
    try {
      // Three quick clock samples, then the stream (its play() still happens within this tap's activation).
      for (let i = 0; i < 3; i++) {
        await readNow(false, undefined);
        if (gen !== generation) return; // Stop was pressed meanwhile
      }
      if (!(await load(n.episodeId)) || gen !== generation) return;
      phase = "listening";
      void followLoop();
      loopTimer = setInterval(tick, TICK_MS);
      clockTimer = setInterval(() => void readNow(false, undefined).catch(() => {}), CLOCK_SAMPLE_MS);
    } catch (err) {
      if (gen !== generation) return;
      stop();
      showError(errorText(err));
    }
  };

  function stop() {
    generation++;
    phase = "idle";
    clearInterval(loopTimer);
    clearInterval(clockTimer);
    poll?.abort();
    poll = null;
    detach();
    playing = null;
    listen.textContent = "Listen";
    listen.className = "primary";
    startAudio.hidden = true;
    status.textContent = "";
    status.classList.remove("synced");
  }

  /** @param {string} text why listening stopped @param {"error" | "info"} kind */
  function end(text, kind) {
    stop();
    toast(text, kind);
  }

  listen.addEventListener("click", () => (phase === "idle" ? void start() : stop()));

  return { element, refresh, stop, fail: (err, retry) => body.fail(err, retry, "Could not load what the TV plays.") };
}
