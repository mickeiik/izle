// @ts-check
// Hash routing and the view scope. Everything a view starts (polls, timers, listeners, the requests it reads with)
// belongs to the scope of the route it was rendered for, and ends with it: work that finishes after the owner left
// the page changes nothing.

import { h, pageTitle } from "./dom.js";
import { api, isAborted } from "./api.js";
import { errorText } from "./lib.js";

/**
 * `retry` runs a failed job again at once (a Retry button). A job's `now()` runs it at once, then on schedule again;
 * a call while it runs makes it run once more afterwards.
 * @typedef {(err: unknown, retry: () => Promise<void>) => void} OnError
 * @typedef {{ now: () => Promise<void> }} Job
 */

/**
 * `read`: a GET below /api/v1/admin that ends with the view; `poll` calls `fn` now and every `ms` while the page is
 * visible; `note`: "Not updated since …" while a poll that had worked keeps failing (the view places it).
 * @typedef {object} Scope
 * @property {AbortSignal} signal
 * @property {(path: string) => Promise<any>} read
 * @property {() => boolean} alive
 * @property {(fn: () => Promise<void>, ms: number, onError?: OnError) => Job} poll
 * @property {(fn: () => Promise<void>, onError?: OnError) => Job} load
 * @property {(fn: () => void, ms: number) => void} later
 * @property {(fn: () => void) => void} onCleanup runs `fn` when the view ends (at once if it already has)
 * @property {(hash: string) => void} go
 * @property {HTMLElement} note
 */

/** The scope of one rendered view; a job's failure goes to `onError` and, when it had worked before, to the note. */
function createScope() {
  const controller = new AbortController();
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {Set<{ lastOk: number, error: unknown }>} each job's last success and current error (null: fine) */
  const jobs = new Set();
  let ended = false;
  // A live region that stays in the page (empty while fresh), so the note is announced when it appears.
  const note = h("p", { class: "stale", role: "status" });

  const updateNote = () => {
    const failing = [...jobs].filter((j) => j.error !== null && j.lastOk > 0).sort((a, b) => a.lastOk - b.lastOk)[0];
    const text = failing ? `Not updated since ${new Date(failing.lastOk).toLocaleTimeString()}. ${errorText(failing.error)} Retrying…` : "";
    if (note.textContent !== text) note.textContent = text;
  };

  /** @param {() => Promise<void>} fn @param {number} ms 0: once @param {OnError} [onError] */
  const job = (fn, ms, onError) => {
    const state = { lastOk: 0, error: /** @type {unknown} */ (null) };
    /** @type {Job} */
    const handle = { now: async () => {} };
    if (ended) return handle;
    jobs.add(state);
    let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
    let running = /** @type {Promise<void> | null} */ (null);
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
        onError?.(err, handle.now);
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
    read: (path) => api("GET", path, undefined, { signal: controller.signal }),
    alive: () => !ended,
    poll: job,
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
 * Starts the router: on every hash change the current view's scope ends and the next view renders in `app`, the focus
 * on its heading. `pick` gets the hash's decoded path parts (`#/catalog/items/x` → `["catalog", "items", "x"]`) and
 * its query (after the first `?`), and returns the view and the nav link to mark current (none: the nav is hidden).
 * @param {{ app: HTMLElement, nav: HTMLElement, before: () => Promise<void>,
 *   pick: (parts: string[], query: URLSearchParams) => { view: (scope: Scope) => HTMLElement, nav?: string } }} o
 */
export function startRouter({ app, nav, before, pick }) {
  let current = /** @type {(Scope & { end(): void }) | null} */ (null);
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
    const [path, query = ""] = location.hash.replace(/^#/, "").split(/\?(.*)/s);
    const r = pick((path || "/devices").split("/").filter(Boolean).map(decode), new URLSearchParams(query));
    nav.hidden = r.nav === undefined;
    for (const a of nav.querySelectorAll("a")) {
      if (a.getAttribute("href") === r.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    current = createScope();
    const view = r.view(current);
    app.replaceChildren(view);
    window.scrollTo(0, 0);
    const heading = view.querySelector("h1");
    if (heading) {
      document.title = pageTitle(heading.textContent);
      heading.tabIndex = -1;
      if (!first) heading.focus({ preventScroll: true });
    }
    first = false;
  };
  window.addEventListener("hashchange", () => void route());
  void route();
}
