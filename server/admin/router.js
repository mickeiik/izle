// @ts-check
// Hash routing (`#/devices`, `#/devices/<id>`, `#/catalog`, `#/catalog/items/<id>`) and the view scope. Everything
// a view starts (polls, timers, listeners, the requests it reads with) belongs to the scope of the route it was
// rendered for, and ends with it: work that finishes after the owner left the page changes nothing.

import { h } from "./dom.js";
import { isAborted } from "./api.js";
import { errorText } from "./lib.js";

/**
 * @typedef {object} Job
 * @property {() => Promise<void>} now runs at once (Retry, or right after an action changed what it shows), then
 *   on schedule again; a call while it runs makes it run once more afterwards
 */

/**
 * @typedef {object} Scope
 * @property {AbortSignal} signal aborted when the view ends: give it to the view's reads
 * @property {() => boolean} alive whether the view is still the one shown
 * @property {(fn: () => Promise<void>, ms: number, onError?: (err: unknown) => void) => Job} poll calls `fn` now and
 *   every `ms` while the page is visible
 * @property {(fn: () => Promise<void>, onError?: (err: unknown) => void) => Job} load calls `fn` once (`now()`
 *   again for Retry)
 * @property {(fn: () => void, ms: number) => void} later a timeout that ends with the view
 * @property {(fn: () => void) => void} onCleanup runs `fn` when the view ends (at once if it already has)
 * @property {(hash: string) => void} go navigates, unless the view already ended
 * @property {HTMLElement} note "Not updated since …" while a poll that had worked keeps failing; the view places it
 */

/**
 * The scope of one rendered view. A job failure is reported to `onError` (a view shows the error and Retry in
 * place of what never loaded) and, for a job that had worked before, in the scope's note. Anything started after
 * `end()` is a no-op.
 */
export function createScope() {
  const controller = new AbortController();
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {Set<{ lastOk: number, error: unknown }>} jobs with their last success and current error (null: fine) */
  const jobs = new Set();
  let ended = false;
  // A live region that stays in the page (empty while fresh), so the note is announced when it appears.
  const note = h("p", { class: "stale", role: "status" });

  const updateNote = () => {
    let since = Infinity;
    /** @type {unknown} */
    let why = null;
    for (const j of jobs) {
      if (j.error !== null && j.lastOk > 0 && j.lastOk < since) {
        since = j.lastOk;
        why = j.error;
      }
    }
    const text = since === Infinity ? "" : `Not updated since ${new Date(since).toLocaleTimeString()}. ${errorText(why)} Retrying…`;
    if (note.textContent !== text) note.textContent = text;
  };

  /** @param {() => Promise<void>} fn @param {number} ms 0: once @param {(err: unknown) => void} [onError] */
  const job = (fn, ms, onError) => {
    const state = { lastOk: 0, error: /** @type {unknown} */ (null) };
    /** @type {Job} */
    const handle = { now: async () => {} };
    if (ended) return handle;
    jobs.add(state);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<void> | null} */
    let running = null;
    let again = false;
    const once = async () => {
      try {
        await fn();
        if (ended) return;
        state.lastOk = Date.now();
        state.error = null;
      } catch (err) {
        if (ended || isAborted(err)) return;
        state.error = err ?? new Error("failed");
        onError?.(err);
      }
      updateNote();
    };
    const tick = async () => {
      if (ended) return;
      if (running) {
        again = true;
        return running;
      }
      clearTimeout(timer);
      running = (async () => {
        do {
          again = false;
          if (ms === 0 || !document.hidden) await once();
        } while (again && !ended);
      })();
      try {
        await running;
      } finally {
        running = null;
        if (!ended && ms > 0) timer = setTimeout(() => void tick(), ms);
      }
    };
    const wake = () => {
      if (!document.hidden) void tick();
    };
    if (ms > 0) document.addEventListener("visibilitychange", wake);
    cleanups.push(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    });
    handle.now = tick;
    void tick();
    return handle;
  };

  /** @type {Scope & { end(): void }} */
  const scope = {
    signal: controller.signal,
    alive: () => !ended,
    poll: (fn, ms, onError) => job(fn, ms, onError),
    load: (fn, onError) => job(fn, 0, onError),
    later(fn, ms) {
      if (ended) return;
      const t = setTimeout(() => !ended && fn(), ms);
      cleanups.push(() => clearTimeout(t));
    },
    onCleanup(fn) {
      if (ended) fn();
      else cleanups.push(fn);
    },
    go(hash) {
      if (!ended) location.hash = hash;
    },
    note,
    end() {
      if (ended) return;
      ended = true;
      controller.abort();
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          // a cleanup that fails must not keep the others from running
        }
      }
    },
  };
  return scope;
}

/**
 * @typedef {object} Route
 * @property {(scope: Scope) => HTMLElement} view
 * @property {string} [nav] the main nav link to mark current (`#/devices`); without it the nav is hidden
 */

/**
 * Starts the router: on every hash change the current view's scope ends and the next view renders in `app`; the
 * focus moves to its heading (`h1`, made focusable), so keyboard and screen reader users start at the top.
 * @param {{ app: HTMLElement, nav: HTMLElement, before: () => Promise<void>, pick: (parts: string[]) => Route }} o
 */
export function startRouter({ app, nav, before, pick }) {
  /** @type {(Scope & { end(): void }) | null} */
  let current = null;
  let seq = 0;
  let first = true;
  const decode = (/** @type {string} */ part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const route = async () => {
    const mine = ++seq;
    current?.end();
    current = null;
    await before();
    if (mine !== seq) return; // another navigation came in meanwhile
    const parts = (location.hash.replace(/^#/, "") || "/devices").split("/").filter(Boolean).map(decode);
    const r = pick(parts);
    nav.hidden = r.nav === undefined;
    for (const a of nav.querySelectorAll("a")) {
      if (a.getAttribute("href") === r.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const scope = createScope();
    current = scope;
    const view = r.view(scope);
    app.replaceChildren(view);
    window.scrollTo(0, 0);
    const heading = view.querySelector("h1");
    if (heading) {
      document.title = `${heading.textContent} · izle admin`;
      heading.tabIndex = -1;
      if (!first) heading.focus({ preventScroll: true });
    }
    first = false;
  };
  window.addEventListener("hashchange", () => void route());
  void route();
}
