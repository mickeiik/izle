// @ts-check
// DOM building blocks of the admin page. The page runs under a strict Content-Security-Policy: elements are built
// with `h` (no HTML parsing), text from the server only ever goes in as text, and widths are set through CSSOM.

import { errorText, plural } from "./lib.js";

/**
 * @typedef {Node | string | number | null | undefined | false} Child
 */

/**
 * Creates an element. `on*` props become listeners, `class` the class name, `value`/`disabled`/`selected` are set
 * as properties, everything else as attributes (`true` as an empty attribute; null, undefined and false
 * leave it out).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value" || k === "disabled" || k === "selected") /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let lastId = 0;
/** A page-unique element id (for `for`, `aria-controls`, `aria-labelledby`). @param {string} prefix */
export const uid = (prefix) => `${prefix}-${++lastId}`;

/** Text for screen readers only (a row's context that the eye gets from the layout). @param {string} text */
export const srOnly = (text) => h("span", { class: "visually-hidden" }, text);

/** The tab title of a view whose heading says `text`. @param {string} text */
export const pageTitle = (text) => `${text} · izle admin`;

/** Sets the view's heading and the tab title together. @param {HTMLElement} heading @param {string} text */
export function setTitle(heading, text) {
  heading.textContent = text;
  document.title = pageTitle(text);
}

/**
 * A view: an optional back link, the title line (the `h1`, and `aside` next to it) and the content.
 * @param {{ back?: [href: string, text: string], title: string | HTMLElement, aside?: Child[] }} head a `title`
 *   text becomes the `h1`
 * @param {...(Child | Child[])} content
 */
export function page({ back, title, aside = [] }, ...content) {
  return h(
    "div",
    { class: "page" },
    back ? h("p", { class: "back" }, h("a", { href: back[0] }, back[1])) : null,
    h("div", { class: "title" }, typeof title === "string" ? h("h1", null, title) : title, aside),
    ...content,
  );
}

/**
 * @typedef {object} CardOptions
 * @property {string} title
 * @property {Child | Child[]} [aside] next to the title: a count, a button
 * @property {Child | Child[]} [intro] a muted paragraph under the title
 */

/**
 * A card: a section with its heading (focusable from script, for the section nav), an optional intro and content.
 * @param {string | CardOptions} opts
 * @param {...(Child | Child[])} children
 */
export function card(opts, ...children) {
  const o = typeof opts === "string" ? { title: opts } : opts;
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", { tabindex: "-1" }, o.title), o.aside),
    o.intro ? h("p", { class: "intro muted" }, o.intro) : null,
    ...children,
  );
}

/** @param {string | null} url @param {string} [alt] */
export const poster = (url, alt = "") => (url ? h("img", { class: "poster", src: url, alt, loading: "lazy" }) : h("div", { class: "poster empty", "aria-hidden": "true" }));

/** A chip's colour: none, a state, or (`server`) a problem the server ran into. @typedef {"ok" | "warn" | "info" | "server" | ""} Tone */

/** @param {string} text @param {Tone} [tone] */
export function chip(text, tone = "") {
  const el = h("span");
  setChip(el, text, tone);
  return el;
}

/** Sets a chip's text and colour (a chip that a poll updates). @param {HTMLElement} el @param {string} text @param {Tone} [tone] */
export function setChip(el, text, tone = "") {
  el.className = tone ? `chip ${tone}` : "chip";
  el.textContent = text;
}

/** @param {{ status: string, online: boolean }} device */
export function statusChip(device) {
  if (device.status === "pending") return chip("Waiting for the TV", "warn");
  return device.online ? chip("Online", "ok") : chip("Offline");
}

/** "3 problems in 24 h" when the TV had problems in the last 24 hours. @param {{ problems?: { recent?: number } }} device */
export function problemsChip(device) {
  const n = device.problems?.recent ?? 0;
  return n > 0 ? chip(`${plural(n, "problem")} in 24 h`, "warn") : null;
}

/**
 * A progress bar (`role="progressbar"`, 0–100): `label` names it for screen readers, `text` says the value in words
 * ("1:30 of 10:00"). Null without a value.
 * @param {number | null} value
 * @param {string} label
 * @param {string} [text]
 */
export function progressBar(value, label, text) {
  if (value === null) return null;
  const bar = h("div", { class: "bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100" }, h("span"));
  setProgress(bar, value, text);
  return bar;
}

/** @param {HTMLElement} bar from `progressBar` @param {number} value @param {string} [text] */
export function setProgress(bar, value, text) {
  bar.setAttribute("aria-valuenow", String(value));
  if (text) bar.setAttribute("aria-valuetext", text);
  else bar.removeAttribute("aria-valuetext");
  /** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${value}%`;
}

// --- loading and failing ------------------------------------------------------------------------------------------

export const loading = () => h("p", { class: "muted loading" }, "Loading…");

/**
 * What stands in for content that could not be loaded: the reason and, given `retry`, a Retry button.
 * @param {unknown} err
 * @param {(() => Promise<unknown>) | null | undefined} retry
 * @param {string} what
 */
export function loadError(err, retry, what) {
  const button = retry ? actionButton("Retry", null, () => retry()) : null;
  return h("div", { class: "callout error", role: "alert" }, h("p", null, h("strong", null, what), " ", errorText(err)), button);
}

/**
 * @typedef {object} Slot
 * @property {HTMLElement} element
 * @property {(...content: Node[]) => void} show replaces what is shown, unless it is already exactly that
 * @property {(err: unknown, retry: (() => Promise<unknown>) | null | undefined, what: string) => void} fail
 *   before anything was shown: the error (and Retry); later failures keep the content, the page's "Not updated
 *   since" note covers them
 */

/**
 * A region that a load fills: "Loading…" first, then its content, or the error and Retry when the first load
 * failed.
 * @returns {Slot}
 */
export function slot() {
  const element = h("div", null, loading());
  let shown = false;
  /** @type {HTMLElement | null} */
  let failure = null;
  return {
    element,
    show(...content) {
      const hadFocus = Boolean(failure?.contains(document.activeElement));
      shown = true;
      failure = null;
      const same = content.length === element.childNodes.length && content.every((c, i) => element.childNodes[i] === c);
      if (!same) element.replaceChildren(...content);
      // Retry worked: the keyboard stays in this region (its first control, else its card's heading).
      if (hadFocus && !focusFirst(element)) {
        const heading = element.closest("section")?.querySelector("h2") ?? document.querySelector("main h1");
        if (heading instanceof HTMLElement) heading.focus({ preventScroll: true });
      }
    },
    fail(err, retry, what) {
      if (shown || failure) return;
      failure = loadError(err, retry, what);
      element.replaceChildren(failure);
    },
  };
}

// --- toasts -------------------------------------------------------------------------------------------------------

const TOAST_MS = { ok: 4000, info: 6000, error: 8000 };
const TOASTS_SHOWN = 4;

/**
 * A short message at the bottom of the page: `role="status"` (errors: `role="alert"`), with a Dismiss button
 * (and Escape). It waits while the pointer is over it or the focus in it.
 * @param {string} text
 * @param {"ok" | "error" | "info"} [kind]
 */
export function toast(text, kind = "ok") {
  const box = document.getElementById("toasts");
  if (!box) return;
  const message = h("span", { class: "toast-text" });
  const close = h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, "✕");
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message, close);
  let left = TOAST_MS[kind];
  let startedAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let hovered = false;
  let focused = false;
  /** @type {EventTarget | null} */
  let returnTo = null;
  const hold = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    left = Math.max(1500, left - (Date.now() - startedAt));
  };
  const run = () => {
    if (hovered || focused || timer !== undefined || !t.isConnected) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, left);
  };
  const dismiss = () => {
    hold();
    const hadFocus = t.contains(document.activeElement);
    t.remove();
    if (hadFocus && returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
  };
  t.addEventListener("mouseenter", () => ((hovered = true), hold()));
  t.addEventListener("mouseleave", () => ((hovered = false), run()));
  t.addEventListener("focusin", (e) => {
    if (!focused) returnTo = e.relatedTarget;
    focused = true;
    hold();
  });
  t.addEventListener("focusout", (e) => {
    if (e.relatedTarget instanceof Node && t.contains(e.relatedTarget)) return;
    focused = false;
    run();
  });
  t.addEventListener("keydown", (e) => e.key === "Escape" && dismiss());
  close.addEventListener("click", dismiss);
  // An alert is announced as it appears; a status region announces text that arrives after it is in the page.
  if (kind === "error") message.textContent = text;
  box.append(t);
  if (kind !== "error") setTimeout(() => (message.textContent = text), 50);
  while (box.childElementCount > TOASTS_SHOWN) box.firstElementChild?.remove();
  run();
}

// --- buttons ------------------------------------------------------------------------------------------------------

/** Whether a button is unavailable or busy (`aria-disabled`): its action does nothing. @param {Element} button */
export const isInert = (button) => button.getAttribute("aria-disabled") === "true";

/** @param {HTMLElement} b */
function syncInert(b) {
  if (b.dataset.off === "true" || b.getAttribute("aria-busy") === "true") b.setAttribute("aria-disabled", "true");
  else b.removeAttribute("aria-disabled");
}

/**
 * Runs `fn` with `button` busy (`aria-busy`, `aria-disabled`, the busy look). While it runs, further calls return
 * at once, so a double click sends one request. The button keeps the keyboard focus: a disabled one would drop it.
 * @param {HTMLElement} button
 * @param {() => Promise<unknown>} fn
 */
export async function busy(button, fn) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  syncInert(button);
  try {
    await fn();
  } finally {
    button.removeAttribute("aria-busy");
    syncInert(button);
  }
}

/**
 * Marks a button unavailable (or available again) without taking it out of the tab order: ▲ on the first row and
 * the remote control after Stop stay where the keyboard is.
 * @param {HTMLElement} button
 * @param {boolean} off
 */
export function setOff(button, off) {
  button.dataset.off = String(off);
  syncInert(button);
}

/**
 * Handles the submission of `form` (the browser's own is prevented). Nothing happens while `button`, its submit
 * button, is inert; else `prepare()` checks what was typed (a toast says what is wrong) and returns the work to run
 * with the button busy, or nothing.
 * @param {HTMLFormElement} form
 * @param {HTMLElement} button
 * @param {() => (() => Promise<unknown>) | null | void} prepare
 */
export function onSubmit(form, button, prepare) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isInert(button)) return;
    const work = prepare();
    if (work) void busy(button, work);
  });
}

/**
 * A button whose action calls the server: busy while `action` runs, and inert while unavailable or busy.
 * @param {string} label the visible text
 * @param {Record<string, any> | null} props class, aria-label (name the row: "Remove Proxy series"), …
 * @param {(button: HTMLButtonElement) => Promise<unknown>} action
 */
export function actionButton(label, props, action) {
  const b = h("button", { type: "button", ...props }, label);
  b.addEventListener("click", () => {
    if (!isInert(b)) void busy(b, () => action(b));
  });
  return b;
}

// --- focus --------------------------------------------------------------------------------------------------------

/**
 * Whether `el` can take the keyboard focus now: in the page, shown, not disabled.
 * @param {Element | null | undefined} el
 * @returns {boolean}
 */
function canFocus(el) {
  return el instanceof HTMLElement && el.isConnected && !(/** @type {any} */ (el).disabled) && el.getClientRects().length > 0;
}

const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";

/**
 * Focuses `root` or the first control in it; with `control`, preferably the one with that `data-control` (the
 * same kind of button the owner was on: "remove" on the row below the one just removed). Whether it found one.
 * @param {HTMLElement} root
 * @param {string} [control]
 */
function focusFirst(root, control) {
  const all = [root, ...root.querySelectorAll(FOCUSABLE)].filter((el) => el.matches(FOCUSABLE) && canFocus(el));
  const el = (control && all.find((e) => e instanceof HTMLElement && e.dataset.control === control)) || all[0];
  if (!(el instanceof HTMLElement)) return false;
  el.focus({ preventScroll: true });
  return true;
}

/**
 * Runs `update`, which may rebuild, move or remove part of the page, and puts the keyboard focus back where the
 * owner was: on the same element if it is still in the page, else on its rebuilt twin (the same `data-focus` key,
 * such as `continue:<episodeId>`), else on the first of `fallbacks` that can take it (elements or keys). Nothing
 * moves when no element had the focus, or when the owner moved it elsewhere meanwhile.
 * @param {() => unknown} update
 * @param {...(HTMLElement | string | null | undefined)} fallbacks
 */
export async function keepFocus(update, ...fallbacks) {
  const before = document.activeElement;
  await update();
  if (!(before instanceof HTMLElement) || before === document.body) return;
  const now = document.activeElement;
  // A focused element that was hidden still is `activeElement` until the browser's next rendering step.
  if (now === before ? canFocus(before) : now && now !== document.body) return;
  for (const c of [before, before.dataset.focus, ...fallbacks]) {
    const el = typeof c === "string" ? document.querySelector(`[data-focus="${CSS.escape(c)}"]`) : c;
    if (canFocus(el)) return /** @type {HTMLElement} */ (el).focus({ preventScroll: true });
  }
}

/**
 * @template T
 * @typedef {{ element: HTMLElement, update(item: T, index: number, all: T[]): void }} Row
 */

/**
 * Keeps `parent`'s children as one row per item, in order, keyed by `keyOf`: a row is created once and kept while
 * its key is there, so a refresh never rebuilds a row that holds the focus or a half-typed value. Rows are moved
 * only when the order changed, and the focus stays on the element that had it. When its row went away, the focus
 * moves to the row that took its place (else the last row; there, to the control of the same `data-control` kind),
 * else to `fallback`.
 * @template T
 * @template {Row<T>} R
 * @param {HTMLElement} parent only the rows live there
 * @param {(item: T) => string} keyOf
 * @param {(item: T) => R} create
 * @param {() => HTMLElement | null} [fallback]
 */
export function keyedRows(parent, keyOf, create, fallback) {
  /** @type {Map<string, R>} */
  const rows = new Map();
  return {
    rows,
    /** @param {T[]} items */
    set(items) {
      const active = document.activeElement;
      const holder = active ? [...parent.children].findIndex((c) => c.contains(active)) : -1;
      const keep = new Set();
      items.forEach((item, i) => {
        const key = keyOf(item);
        keep.add(key);
        let row = rows.get(key);
        if (!row) rows.set(key, (row = create(item)));
        row.update(item, i, items);
        const at = parent.children[i];
        if (at !== row.element) parent.insertBefore(row.element, at ?? null);
      });
      for (const [key, row] of rows) {
        if (keep.has(key)) continue;
        row.element.remove();
        rows.delete(key);
      }
      if (!(active instanceof HTMLElement) || active === document.activeElement || holder < 0) return;
      // Moving an element drops its focus: give it back, or hand it to the neighbour of a row that went away.
      if (canFocus(active)) return active.focus({ preventScroll: true });
      const next = /** @type {HTMLElement | undefined} */ (parent.children[Math.min(holder, parent.children.length - 1)]);
      if (next) focusFirst(next, active.dataset.control);
      else {
        const f = fallback?.();
        if (f && canFocus(f)) f.focus({ preventScroll: true });
      }
    },
  };
}

// --- shows --------------------------------------------------------------------------------------------------------

/**
 * A show in a list: its poster, title and a muted line, and `end` at the right. With `href` the whole row is a link
 * (with a chevron).
 * @param {{ title: string, posterUrl: string | null }} item
 * @param {{ meta?: Child | Child[], href?: string, end?: Child | Child[] }} [o]
 */
export function showRow(item, o = {}) {
  /** @type {Array<Child | Child[]>} */
  const body = [poster(item.posterUrl), h("div", { class: "grow" }, h("strong", null, item.title), o.meta ? h("div", { class: "muted" }, o.meta) : null), o.end];
  return o.href ? h("a", { class: "row link", href: o.href }, ...body) : h("div", { class: "row" }, ...body);
}

/**
 * Searches as the owner types: `search(query)` runs 200 ms after the last keystroke, and its answer is shown only
 * when no newer search started meanwhile (an older answer that arrives late is dropped). `run()` searches at once.
 * @template T
 * @param {import("./router.js").Scope} scope the view: its end cancels a pending search
 * @param {HTMLInputElement} input
 * @param {(query: string) => Promise<T>} search
 * @param {(result: T, query: string) => void} show
 * @param {(err: unknown) => void} fail
 */
export function liveSearch(scope, input, search, show, fail) {
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const run = async () => {
    clearTimeout(timer);
    const mine = ++seq;
    const query = input.value;
    try {
      const result = await search(query);
      if (mine === seq && scope.alive()) show(result, query);
    } catch (err) {
      if (mine === seq && scope.alive()) fail(err);
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  });
  scope.onCleanup(() => clearTimeout(timer));
  return { run };
}
