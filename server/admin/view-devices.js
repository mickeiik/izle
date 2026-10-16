// @ts-check
// TVs: the pairing codes waiting for approval and the paired TVs, refreshed every 3 s. Rows are kept per code and
// per TV, so a half-typed name and the keyboard focus survive the refresh.

import { api, attempt } from "./api.js";
import { card, chip, h, keyedRows, onSubmit, page, setOff, slot, srOnly, statusChip, toast } from "./dom.js";
import { watchEvents } from "./events.js";
import { formatCode, formatCountdown, formatRelative, plural, serverAddress } from "./lib.js";

/** @param {import("./router.js").Scope} scope */
export function devicesView(scope) {
  const pendingSlot = slot();
  const devicesSlot = slot();
  const pendingList = h("div", { class: "list" });
  const address = h("code", null, serverAddress(location.origin, location.pathname));
  const pendingEmpty = h("p", { class: "muted" }, "No TV is waiting. Open izle on the TV and enter ", address, " as the server address: it then shows a 6-digit code.");
  const devicesList = h("div", { class: "list" });
  const devicesEmpty = h("p", { class: "muted" }, "No TV is paired yet.");
  /** The active TVs, for the "replaces" choice of a pending code. @type {Array<{ id: string, name: string }>} */
  let active = [];

  /** One form per open code. @param {any} c */
  const pendingRow = (c) => {
    const code = formatCode(c.code);
    const name = h("input", { type: "text", maxlength: 60, placeholder: "Name (optional), e.g. Living room", "aria-label": `Name for the TV showing ${code}` });
    // "Replaces": the new TV takes over an existing one (its name, settings, home screen and history) instead of
    // being a new TV; the old TV's token stops working. Shown only while there is a TV to take over.
    const replaces = h("select", { "aria-label": `What the TV showing ${code} becomes`, hidden: true });
    const countdown = h("span", { class: "muted" });
    const approve = h("button", { class: "primary", type: "submit", "data-control": "approve", "aria-label": `Approve ${code}` }, "Approve");
    const element = h("form", { class: "row pair" }, h("div", { class: "code" }, srOnly("Code "), code), h("div", { class: "grow" }, name, replaces, countdown), approve);
    const fillReplaces = () => {
      const current = replaces.value;
      replaces.replaceChildren(h("option", { value: "", selected: current === "" }, "A new TV"), ...active.map((d) => h("option", { value: d.id, selected: d.id === current }, `Replaces “${d.name}”`)));
      replaces.hidden = active.length === 0;
    };
    replaces.addEventListener("change", () => (name.hidden = replaces.value !== ""));
    onSubmit(element, approve, () => {
      const n = name.value.trim();
      const old = replaces.value;
      return async () => {
        const body = { code: c.code, ...(old ? { replaces: old } : n ? { name: n } : {}) };
        const r = await attempt(() => api("POST", "/pair/approve", body));
        if (!r.ok) return;
        toast(old ? `Approved: the TV takes over “${r.value.name}” as soon as it connects.` : `Approved as “${r.value.name}”. The TV will show its home screen in a moment.`);
        await job.now();
      };
    });
    return {
      element,
      /** @param {any} next */
      update(next) {
        name.disabled = next.approved;
        replaces.disabled = next.approved;
        fillReplaces();
        setOff(approve, next.approved);
        countdown.textContent = next.approved ? "Approved — waiting for the TV to pick it up" : `Expires in ${formatCountdown(next.expiresAt)}`;
      },
    };
  };

  /** @param {any} d */
  const deviceRow = (d) => {
    const name = h("strong");
    const meta = h("div", { class: "muted" });
    const chips = h("div", { class: "chips" });
    const element = h("a", { class: "row link", href: `#/devices/${encodeURIComponent(d.id)}` }, h("div", { class: "grow" }, name, meta), chips);
    return {
      element,
      /** @param {any} next */
      update(next) {
        name.textContent = next.name;
        meta.textContent = `${plural(next.homeCount, "show")} on Home · seen ${formatRelative(next.lastSeenAt)}`;
        const n = next.problems?.recent ?? 0;
        const problems = n > 0 ? chip(`${plural(n, "problem")} in 24 h`, "warn") : null;
        chips.replaceChildren(...[problems, statusChip(next)].filter((c) => c !== null));
      },
    };
  };

  const pendingRows = keyedRows(pendingList, (/** @type {any} */ c) => c.code, pendingRow);
  const deviceRows = keyedRows(devicesList, (/** @type {any} */ d) => d.id, deviceRow);

  const refresh = async () => {
    const [codes, list] = await Promise.all([scope.read("/pair/pending"), scope.read("/devices")]);
    active = list.devices.filter((/** @type {any} */ d) => d.status === "active").map((/** @type {any} */ d) => ({ id: d.id, name: d.name }));
    pendingRows.set(codes.codes);
    pendingEmpty.hidden = codes.codes.length > 0;
    pendingSlot.show(pendingEmpty, pendingList);
    deviceRows.set(list.devices);
    devicesEmpty.hidden = list.devices.length > 0;
    devicesSlot.show(devicesEmpty, devicesList);
  };
  const job = scope.poll(refresh, 3000, (err) => {
    pendingSlot.fail(err, job.now, "Could not load the TVs.");
    devicesSlot.fail(err, null, "Could not load the TVs.");
  });
  // TVs coming and going, codes appearing: at once, not at the next poll.
  watchEvents(scope, { types: ["device.", "pairing.", "problem.recorded"] }, () => void job.now());

  return page(
    { title: "TVs" },
    scope.note,
    card({ title: "Pair a TV", intro: "Approve only the code that your TV shows." }, pendingSlot.element),
    card("Paired TVs", devicesSlot.element),
  );
}
