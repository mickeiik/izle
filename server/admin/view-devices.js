// @ts-check
// TVs: the pairing codes waiting for approval and the paired TVs, refreshed every 3 s. Rows are kept per code and
// per TV, so a half-typed name and the keyboard focus survive the refresh.

import { api, attempt } from "./api.js";
import { busy, card, h, isInert, keyedRows, problemsChip, setOff, slot, srOnly, statusChip, toast } from "./dom.js";
import { formatCode, formatCountdown, formatRelative, plural, serverAddress } from "./lib.js";

/** @param {import("./router.js").Scope} scope */
export function devicesView(scope) {
  const read = (/** @type {string} */ path) => api("GET", path, undefined, { signal: scope.signal });
  const pendingSlot = slot();
  const devicesSlot = slot();
  const pendingList = h("div", { class: "list" });
  const pendingEmpty = h(
    "p",
    { class: "muted" },
    "No TV is waiting. Open izle on the TV and enter ",
    h("code", null, serverAddress(location.origin, location.pathname)),
    " as the server address: it then shows a 6-digit code.",
  );
  const devicesList = h("div", { class: "list" });
  const devicesEmpty = h("p", { class: "muted" }, "No TV is paired yet.");

  /** One form per open code. @param {any} c */
  const pendingRow = (c) => {
    const code = formatCode(c.code);
    const name = h("input", { type: "text", maxlength: 60, placeholder: "Name (optional), e.g. Living room", "aria-label": `Name for the TV showing ${code}` });
    const countdown = h("span", { class: "muted" });
    const approve = h("button", { class: "primary", type: "submit", "data-control": "approve", "aria-label": `Approve ${code}` }, "Approve");
    const element = h(
      "form",
      {
        class: "row pair",
        onsubmit: (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          if (isInert(approve)) return;
          const n = name.value.trim();
          void busy(approve, async () => {
            const r = await attempt(() => api("POST", "/pair/approve", { code: c.code, ...(n ? { name: n } : {}) }));
            if (!r.ok) return;
            toast(`Approved as “${r.value.name}”. The TV will show its home screen in a moment.`);
            await job.now();
          });
        },
      },
      h("div", { class: "code" }, srOnly("Code "), code),
      h("div", { class: "grow" }, name, countdown),
      approve,
    );
    return {
      element,
      /** @param {any} next */
      update(next) {
        name.disabled = next.approved;
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
        chips.replaceChildren(...[problemsChip(next), statusChip(next)].filter((c) => c !== null));
      },
    };
  };

  const pendingRows = keyedRows(pendingList, (/** @type {any} */ c) => c.code, pendingRow);
  const deviceRows = keyedRows(devicesList, (/** @type {any} */ d) => d.id, deviceRow);

  const refresh = async () => {
    const [codes, list] = await Promise.all([read("/pair/pending"), read("/devices")]);
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

  return h(
    "div",
    { class: "page" },
    h("div", { class: "title" }, h("h1", null, "TVs")),
    scope.note,
    card({ title: "Pair a TV", intro: "Approve only the code that your TV shows." }, pendingSlot.element),
    card("Paired TVs", devicesSlot.element),
  );
}
