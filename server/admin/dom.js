// @ts-check
// DOM building blocks of the admin page. It runs under a strict Content-Security-Policy: elements are built with `h`
// (no HTML parsing), text from the server only ever goes in as text, and widths are set through CSSOM.

import { errorText } from "./lib.js";

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * Creates an element. `on*` props become listeners, `class` the class name, `value`/`disabled`/`selected` are set
 * as properties, everything else as attributes (`true` as an empty attribute; null, undefined and false leave it out).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Record<string, any> | null} [props] @param {...(Child | Child[])} children
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
/** @param {string} prefix */
export const uid = (prefix) => `${prefix}-${++lastId}`;

/** @param {string} text */
export const srOnly = (text) => h("span", { class: "visually-hidden" }, text);

/** @param {string} text */
export const pageTitle = (text) => `${text} · izle admin`;

/** @param {HTMLElement} heading @param {string} text */
export function setTitle(heading, text) {
  heading.textContent = text;
  document.title = pageTitle(text);
}

/** @param {ReadonlyArray<readonly [string, string]>} list `[value, text]` pairs @param {string} [selected] */
export const options = (list, selected) =>
  list.map(([value, text]) => h("option", { value, selected: value === selected }, text));

/** The terms and details of a `<dl class="facts">`. @param {Array<[string, Child | Child[]]>} rows */
export const factRows = (rows) => rows.flatMap(([dt, dd]) => [h("dt", null, dt), h("dd", null, dd)]);
/** @param {Array<[string, Child | Child[]]>} rows */
export const factList = (rows) => h("dl", { class: "facts" }, factRows(rows));


/**
 * @param {{ back?: [href: string, text: string], title: string | HTMLElement, aside?: Child[] }} head
 * @param {...(Child | Child[])} content
 */
export function page({ back, title, aside = [] }, ...content) {
  const backLink = back ? h("p", { class: "back" }, h("a", { href: back[0] }, back[1])) : null;
  const heading = h("div", { class: "title" }, typeof title === "string" ? h("h1", null, title) : title, aside);
  return h("div", { class: "page" }, backLink, heading, ...content);
}

/**
 * A card: a section with its heading (focusable from script), `aside` next to it, a muted `intro` and content.
 * @param {string | { title: string, aside?: Child | Child[], intro?: Child | Child[] }} opts
 * @param {...(Child | Child[])} children
 */
export function card(opts, ...children) {
  const o = typeof opts === "string" ? { title: opts } : opts;
  const head = h("div", { class: "card-head" }, h("h2", { tabindex: "-1" }, o.title), o.aside);
  return h("section", { class: "card" }, head, o.intro ? h("p", { class: "intro muted" }, o.intro) : null, ...children);
}

/**
 * Tabs, only the selected panel shown. ← → Home End move between the tabs and select them (the selected tab is the
 * only one in the Tab order). `onSelect` runs when another tab was selected; `setBadge` shows a count by a label.
 * @param {{ label: string, tabs: Array<{ key: string, label: string, content: Child[] }>, selected: string,
 *   onSelect?: (key: string) => void }} o
 */
export function tabs({ label, tabs: defs, selected, onSelect }) {
  const id = uid("tab");
  const items = defs.map((t) => {
    const badge = h("span", { class: "badge", hidden: true });
    const tab = h("button", { type: "button", role: "tab", id: `${id}-${t.key}`, "aria-controls": `${id}-${t.key}-panel` }, t.label, badge);
    const panel = h("div", { role: "tabpanel", id: `${id}-${t.key}-panel`, "aria-labelledby": tab.id, class: "tab-panel" }, ...t.content);
    return { key: t.key, tab, panel, badge };
  });
  let current = "";
  const select = (/** @type {string} */ key) => {
    const at = items.find((t) => t.key === key) ?? items[0];
    for (const t of items) {
      t.tab.setAttribute("aria-selected", String(t === at));
      t.tab.tabIndex = t === at ? 0 : -1;
      t.panel.hidden = t !== at;
    }
    if (at.key === current) return;
    if (current !== "") onSelect?.(at.key);
    current = at.key;
  };
  for (const [i, t] of items.entries()) {
    t.tab.addEventListener("click", () => select(t.key));
    t.tab.addEventListener("keydown", (e) => {
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: items.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = items[(to + items.length) % items.length];
      select(next.key);
      next.tab.focus();
      next.tab.scrollIntoView({ block: "nearest", inline: "nearest" }); // the list scrolls sideways on phones
    });
  }
  select(selected);
  return {
    list: h("div", { role: "tablist", class: "tabs", "aria-label": label }, items.map((t) => t.tab)),
    panels: items.map((t) => t.panel),
    /** @param {string} key @param {string} text */
    setBadge(key, text) {
      const t = items.find((x) => x.key === key);
      if (!t || t.badge.textContent === text) return;
      t.badge.textContent = text;
      t.badge.hidden = !text;
    },
  };
}

/** @param {string | null} url @param {string} [alt] */
export const poster = (url, alt = "") => (url ? h("img", { class: "poster", src: url, alt, loading: "lazy" }) : h("div", { class: "poster empty", "aria-hidden": "true" }));

/**
 * A chip's colour: `server` a problem the server ran into, `bad` a check that failed, `live` a channel (red as on the
 * TV).
 * @typedef {"ok" | "warn" | "bad" | "info" | "server" | "live" | ""} Tone
 */

/** @param {string} text @param {Tone} [tone] */
export function chip(text, tone = "") {
  const el = h("span");
  setChip(el, text, tone);
  return el;
}

/** @param {HTMLElement} el @param {string} text @param {Tone} [tone] */
export function setChip(el, text, tone = "") {
  el.className = tone ? `chip ${tone}` : "chip";
  el.textContent = text;
}

/** @param {{ status: string, online: boolean }} device */
export function statusChip(device) {
  if (device.status === "pending") return chip("Waiting for the TV", "warn");
  return device.online ? chip("Online", "ok") : chip("Offline");
}

/** A 0–100 bar (null without a value). @param {number | null} value @param {string} label @param {string} [text] */
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

/** @param {unknown} err @param {(() => Promise<unknown>) | null | undefined} retry @param {string} what */
export function loadError(err, retry, what) {
  const button = retry ? actionButton("Retry", null, () => retry()) : null;
  return h("div", { class: "callout error", role: "alert" }, h("p", null, h("strong", null, what), " ", errorText(err)), button);
}

/**
 * A region that a load fills: "Loading…", then its content (`show` keeps content that is already exactly that).
 * `fail` shows the error and Retry only before anything was shown; the page's "Not updated since" covers the rest.
 */
export function slot() {
  const element = h("div", null, loading());
  let shown = false;
  let failure = /** @type {HTMLElement | null} */ (null);
  return {
    element,
    /** @param {...Node} content */
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
    /** @param {unknown} err @param {(() => Promise<unknown>) | null | undefined} retry @param {string} what */
    fail(err, retry, what) {
      if (shown || failure) return;
      failure = loadError(err, retry, what);
      element.replaceChildren(failure);
    },
  };
}

// --- toasts -------------------------------------------------------------------------------------------------------

const TOAST_MS = { ok: 4000, info: 6000, error: 8000 };

/**
 * A short message at the bottom of the page (errors as alerts) with Dismiss (and Escape); at most four are shown. It
 * waits while the pointer is over it or the focus in it.
 * @param {string} text @param {"ok" | "error" | "info"} [kind]
 */
export function toast(text, kind = "ok") {
  const box = document.getElementById("toasts");
  if (!box) return;
  const message = h("span", { class: "toast-text" });
  const close = h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, "✕");
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message, close);
  let left = TOAST_MS[kind];
  let startedAt = 0;
  let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  let hovered = false;
  let focused = false;
  let returnTo = /** @type {EventTarget | null} */ (null);
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
  while (box.childElementCount > 4) box.firstElementChild?.remove();
  run();
}

// --- buttons ------------------------------------------------------------------------------------------------------
// Buttons are never `disabled`, which would drop the keyboard focus: an unavailable or busy one is `aria-disabled`
// and its action does nothing.

/** @param {Element} button */
const isInert = (button) => button.getAttribute("aria-disabled") === "true";

/** @param {HTMLElement} b */
function syncInert(b) {
  if (b.dataset.off === "true" || b.getAttribute("aria-busy") === "true") b.setAttribute("aria-disabled", "true");
  else b.removeAttribute("aria-disabled");
}

/**
 * Runs `fn` with `button` busy; further calls meanwhile return at once, so a double click sends one request.
 * @param {HTMLElement} button @param {() => Promise<unknown>} fn
 */
async function busy(button, fn) {
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

/** Marks a button unavailable (or available again). @param {HTMLElement} button @param {boolean} off */
export function setOff(button, off) {
  button.dataset.off = String(off);
  syncInert(button);
}

/**
 * Handles the submission of `form` unless its `button` is inert: `prepare()` checks what was typed (a toast says what
 * is wrong) and returns the work to run with the button busy, or nothing.
 * @param {HTMLFormElement} form @param {HTMLElement} button
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
 * @param {string} label @param {Record<string, any> | null} props
 * @param {(button: HTMLButtonElement) => Promise<unknown>} action runs with the button busy
 */
export function actionButton(label, props, action) {
  const b = h("button", { type: "button", ...props }, label);
  b.addEventListener("click", () => {
    if (!isInert(b)) void busy(b, () => action(b));
  });
  return b;
}

// --- focus --------------------------------------------------------------------------------------------------------

/** Whether `el` can take the focus now: in the page, shown, not disabled. @param {Element | null | undefined} el */
function canFocus(el) {
  return el instanceof HTMLElement && el.isConnected && !(/** @type {any} */ (el).disabled) && el.getClientRects().length > 0;
}

const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";

/**
 * Focuses `root` or its first control, preferably the one with `data-control` = `control` (the same kind of button
 * the owner was on). Whether it found one. @param {HTMLElement} root @param {string} [control]
 */
export function focusFirst(root, control) {
  const all = [root, ...root.querySelectorAll(FOCUSABLE)].filter((el) => el.matches(FOCUSABLE) && canFocus(el));
  const el = (control && all.find((e) => e instanceof HTMLElement && e.dataset.control === control)) || all[0];
  if (!(el instanceof HTMLElement)) return false;
  el.focus({ preventScroll: true });
  return true;
}

/**
 * Runs `update`, which may rebuild, move or remove part of the page, and puts the focus back where the owner was: on
 * the same element if it is still in the page, else on its rebuilt twin (the same `data-focus` key), else on the
 * first of `fallbacks` (elements or keys) that can take it. Nothing moves when the owner moved the focus meanwhile.
 * @param {() => unknown} update @param {...(HTMLElement | string | null | undefined)} fallbacks
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
 * Keeps `parent`'s children as one row per item, in order, keyed by `keyOf`: a row is created once and kept while
 * its key is there, so a refresh never rebuilds a row that holds the focus or a half-typed value. When the focused
 * row went away, the focus moves to the row that took its place (else the last row), onto its control of the same
 * `data-control` kind (else its first control); with no row left, to `fallback`.
 * @template T
 * @template {{ element: HTMLElement, update(item: T, index: number, all: T[]): void }} R
 * @param {HTMLElement} parent @param {(item: T) => string} keyOf @param {(item: T) => R} create
 * @param {() => HTMLElement | null} [fallback]
 */
export function keyedRows(parent, keyOf, create, fallback) {
  /** @type {Map<string, R>} */
  const rows = new Map();
  return {
    /** @param {T[]} items */
    set(items) {
      const active = document.activeElement;
      const holder = active ? [...parent.children].findIndex((c) => c.contains(active)) : -1;
      const keep = new Set(items.map(keyOf));
      items.forEach((item, i) => {
        const key = keyOf(item);
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
      const f = next ? null : fallback?.();
      if (next) focusFirst(next, active.dataset.control);
      else if (f && canFocus(f)) f.focus({ preventScroll: true });
    },
  };
}

/** A row's grow column: a bold title, a muted line. @param {Child | Child[]} title @param {Child | Child[]} [meta] */
export const rowText = (title, meta) =>
  h("div", { class: "grow" }, h("strong", null, title), meta ? h("div", { class: "muted" }, meta) : null);

/**
 * A show in a list: its poster, title and a muted line, and `end` at the right. With `href` the whole row is a link.
 * @param {{ title: string, posterUrl: string | null }} item
 * @param {{ meta?: Child | Child[], href?: string, end?: Child | Child[] }} [o]
 */
export function showRow(item, o = {}) {
  const body = [poster(item.posterUrl), rowText(item.title, o.meta), o.end];
  return o.href ? h("a", { class: "row link", href: o.href }, ...body) : h("div", { class: "row" }, ...body);
}
