// @ts-check
// Batch checks (a whole show, a TV's whole Home), shared by the show page and a TV's Home tab: starting one, following
// its progress with a long-poll on `seq` while the view lives, Stop, and the chip of a stored check. One check runs at a
// time on the server: starting another attaches to the one already going and says what it checks.

import { ApiError, api, attempt, isAborted } from "./api.js";
import { actionButton, chip, h, progressBar, setChip, setProgress, toast } from "./dom.js";
import { checkSummaryText, errorText, percent, runProgressText, runTitle, skippedText, verdictChip } from "./lib.js";

/** How long one long-poll waits for news, in ms (the server's limit). */
const WAIT_MS = 25_000;
/** The pause before trying again after a failed poll. */
const RETRY_MS = 3000;

/** What a pass means, under the check controls. */
export const CHECK_NOTE = "A pass means the server reached real media along the TV's path just now; it does not prove the TV can decode the codecs.";

/** @param {HTMLElement} el @param {{ mark: string, text: string, tone: import("./dom.js").Tone }} c */
function fill(el, c) {
  setChip(el, c.text, c.tone);
  if (c.mark) el.prepend(h("span", { "aria-hidden": "true" }, `${c.mark} `));
}

/** A stored check's chip, its mark beside the words. @param {any} check a CheckSummary, or null */
export function checkChip(check) {
  const el = chip("");
  setCheckChip(el, check);
  return el;
}

/** @param {HTMLElement} el a chip @param {any} check a CheckSummary, or null */
export const setCheckChip = (el, check) => fill(el, checkSummaryText(check));

/** @param {HTMLElement} el a chip @param {"ok" | "warn" | "fail"} verdict */
export const setVerdictChip = (el, verdict) => fill(el, verdictChip(verdict));

/**
 * A batch check's progress under the view's own start buttons: what it checks, "12 of 40 checked · 1 failing" (read
 * out as it changes), the bar, what was skipped, and Stop. On open it attaches to a check already running for this
 * view (`mine`). `changed(running)` runs when a check starts or ends (the view turns its start buttons off meanwhile);
 * `ended(run)` once a followed check is done or stopped, to read the results again.
 * @param {import("./router.js").Scope} scope
 * @param {{ mine: (target: any) => boolean, changed: (running: boolean) => void, ended: (run: any) => void }} o
 */
export function checkRun(scope, { mine, changed, ended }) {
  const title = h("strong");
  const text = h("p", { class: "check-text", "aria-live": "polite", tabindex: "-1" });
  const bar = /** @type {HTMLElement} */ (progressBar(0, "Checked"));
  const skipped = h("p", { class: "muted hint" });
  /** The check shown (the newest answer about it). @type {any} */
  let run = null;
  /** The long-poll that follows `run`; aborted when another check is followed or the view ends. */
  let follow = /** @type {AbortController | null} */ (null);
  scope.onCleanup(() => follow?.abort());

  const stop = actionButton("Stop", { class: "danger" }, async () => {
    if (run?.state !== "running") return;
    const r = await attempt(() => api("DELETE", `/checks/${encodeURIComponent(run.id)}`));
    if (r.ok) show(r.value.run);
  });
  const element = h("div", { class: "check-run", hidden: true },
    h("div", { class: "row top-align" }, h("div", { class: "grow" }, title, text, bar, skipped), stop));

  /** @param {any} next */
  const show = (next) => {
    if (run && next.id === run.id && next.seq < run.seq) return; // an older answer that crossed a newer one
    run = next;
    element.hidden = false;
    title.textContent = runTitle(next);
    const progress = runProgressText(next);
    if (text.textContent !== progress) text.textContent = progress;
    setProgress(bar, percent(next.done, next.total) ?? 100, progress);
    skipped.textContent = skippedText(next);
    skipped.hidden = !skipped.textContent;
    // Stop goes once the check ends; the focus that was on it goes to the result.
    const hadFocus = stop === document.activeElement;
    stop.hidden = next.state !== "running";
    if (hadFocus && stop.hidden) text.focus({ preventScroll: true });
    stop.setAttribute("aria-label", `Stop checking ${runTitle(next)}`);
  };

  const pause = (/** @type {number} */ ms) => new Promise((resolve) => scope.later(() => resolve(undefined), ms));

  /** Shows `first` and follows it until it is done or stopped, then `ended`. @param {any} first */
  const track = async (first) => {
    follow?.abort();
    const controller = (follow = new AbortController());
    const { signal } = controller;
    run = null;
    show(first);
    changed(true);
    while (run.state === "running" && !signal.aborted) {
      try {
        const r = await api("GET", `/checks/${encodeURIComponent(run.id)}?seq=${run.seq}&wait=${WAIT_MS}`, undefined, { signal });
        if (!signal.aborted) show(r.run);
      } catch (err) {
        if (signal.aborted || isAborted(err) || !scope.alive()) return;
        if (err instanceof ApiError && err.code === "unknown_check") {
          text.textContent = errorText(err);
          if (stop === document.activeElement) text.focus({ preventScroll: true });
          stop.hidden = true;
          break;
        }
        await pause(RETRY_MS);
      }
    }
    if (signal.aborted || !scope.alive()) return;
    follow = null;
    changed(false);
    ended(run);
  };

  // A check already running for this view (the owner left the page and came back): follow it.
  void scope.read("/checks/current").then((r) => {
    if (r.run?.state === "running" && mine(r.run.target) && !follow) void track(r.run);
  }, () => {});

  return {
    element,
    /** Whether a check is being followed. */
    running: () => follow !== null,
    /**
     * Starts a check of `body` (`{ itemId }`, or `{ deviceId, mode }`) and follows it; while another check runs, follows
     * that one instead and says what it checks.
     * @param {any} body
     */
    async start(body) {
      const r = await attempt(async () => {
        try {
          return { run: (await api("POST", "/checks", body, { signal: scope.signal })).run, other: false };
        } catch (err) {
          const runId = err instanceof ApiError && err.code === "check_running" ? err.body?.runId : null;
          if (typeof runId !== "string") throw err;
          return { run: (await scope.read(`/checks/${encodeURIComponent(runId)}`)).run, other: true };
        }
      });
      if (!r.ok) return;
      if (r.value.other) toast(`Another check is running: ${runTitle(r.value.run)}. Its progress shows here; start yours once it is done.`, "info");
      if (r.value.run.state === "running") void track(r.value.run);
    },
  };
}
