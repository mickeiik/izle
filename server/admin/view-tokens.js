// @ts-check
// Who else has access: the owner's phones (connected from a TV, with owner access), disconnected here, and the access
// tokens for apps and agents, with their scope, created and revoked here. A new token's secret is shown once, right
// after it is created, and never again (the server keeps only its hash).

import { api, attempt } from "./api.js";
import { actionButton, card, chip, h, keyedRows, onSubmit, options, page, slot, toast } from "./dom.js";
import { watchEvents } from "./events.js";
import { SCOPES, formatRelative, phoneEventText, phoneLine, scopeLabel } from "./lib.js";

/** The phones connected from a TV: each with the TV it came through and its dates, and Disconnect. @param {import("./router.js").Scope} scope */
function phonesCard(scope) {
  const listSlot = slot();
  const list = h("div", { class: "list" });
  const empty = h("p", { class: "muted" }, "No phone yet. A phone connects from a TV: on the TV, open the hidden menu, then Settings → Connect a phone, and scan the code with the phone (it needs the izle companion app).");
  /** @type {Array<{ id: string, name: string }>} */
  let devices = [];

  const phoneRow = (/** @type {any} */ p) => {
    const name = h("strong");
    const meta = h("div", { class: "muted" });
    const disconnect = actionButton("Disconnect", { class: "danger", "data-control": "disconnect", "aria-label": `Disconnect ${p.name}` }, async () => {
      if (!confirm(`Disconnect “${p.name}”? It loses access at once; to use it again, connect it from a TV.`)) return;
      const r = await attempt(() => api("DELETE", `/phones/${encodeURIComponent(p.id)}`), `“${p.name}” disconnected.`);
      if (r.ok) await job.now();
    });
    return {
      element: h("div", { class: "row" }, h("div", { class: "grow" }, name, meta), disconnect),
      /** @param {any} next */
      update(next) {
        name.textContent = next.name;
        meta.textContent = phoneLine(next, devices);
      },
    };
  };
  const rows = keyedRows(list, (/** @type {any} */ p) => p.id, phoneRow);

  const refresh = async () => {
    const [{ phones }, tvs] = await Promise.all([scope.read("/phones"), scope.read("/devices")]);
    devices = tvs.devices;
    rows.set(phones);
    empty.hidden = phones.length > 0;
    listSlot.show(empty, list);
  };
  const job = scope.poll(refresh, 30_000, (err) => listSlot.fail(err, job.now, "Could not load the phones."));
  watchEvents(scope, { types: ["phone.", "device.removed", "device.updated"] }, (e) => {
    const text = phoneEventText(e);
    if (text && e.type === "phone.connected") toast(text, "info");
    void job.now();
  });

  const intro = "A phone with the izle companion app has full access, like this page. It connects from a TV; disconnect a lost one here, or from the server's shell: izle-server phone list, phone disconnect <id>.";
  return card({ title: "Phones", intro }, listSlot.element);
}

/** @param {import("./router.js").Scope} scope */
export function tokensView(scope) {
  const listSlot = slot();
  const list = h("div", { class: "list" });
  const empty = h("p", { class: "muted" }, "No access token yet. An app or an agent that should see or run the TVs gets one below; the admin page itself always uses the owner token.");

  const tokenRow = (/** @type {any} */ t) => {
    const name = h("strong");
    const meta = h("div", { class: "muted" });
    const scopeChip = chip("");
    const revoke = actionButton("Revoke", { class: "danger", "data-control": "revoke", "aria-label": `Revoke ${t.name}` }, async () => {
      if (!confirm(`Revoke “${t.name}”? Whatever uses it stops working at once.`)) return;
      const r = await attempt(() => api("DELETE", `/tokens/${encodeURIComponent(t.id)}`), `“${t.name}” revoked.`);
      if (r.ok) await job.now();
    });
    return {
      element: h("div", { class: "row" }, h("div", { class: "grow" }, name, meta), scopeChip, revoke),
      /** @param {any} next */
      update(next) {
        name.textContent = next.name;
        scopeChip.textContent = scopeLabel(next.scope);
        meta.textContent = `created ${formatRelative(next.createdAt)} · last used ${formatRelative(next.lastUsedAt)}`;
      },
    };
  };
  const rows = keyedRows(list, (/** @type {any} */ t) => t.id, tokenRow);

  const refresh = async () => {
    const { tokens } = await scope.read("/tokens");
    rows.set(tokens);
    empty.hidden = tokens.length > 0;
    listSlot.show(empty, list);
  };
  const job = scope.poll(refresh, 30_000, (err) => listSlot.fail(err, job.now, "Could not load the tokens."));

  const name = h("input", { type: "text", id: "t-name", maxlength: 60, required: true, placeholder: "e.g. Home assistant", autocomplete: "off" });
  const scopeSelect = h("select", { id: "t-scope", "aria-describedby": "t-scope-hint" }, options(SCOPES.map(([value, label]) => [value, label]), "read"));
  const scopeHint = h("p", { class: "hint", id: "t-scope-hint" });
  const describe = () => (scopeHint.textContent = SCOPES.find(([s]) => s === scopeSelect.value)?.[2] ?? "");
  scopeSelect.addEventListener("change", describe);
  describe();
  const create = h("button", { type: "submit", class: "primary" }, "Create token");
  const secretBox = h("div", { class: "callout info secret", role: "status", hidden: true });
  const form = h("form", { class: "form" }, h("label", { for: "t-name" }, "Name"), name, h("label", { for: "t-scope" }, "Scope"), scopeSelect, scopeHint, h("div", { class: "actions" }, create));
  onSubmit(form, create, () => {
    const n = name.value.trim();
    if (!n) return toast("Give the token a name first.", "info");
    return async () => {
      const r = await attempt(() => api("POST", "/tokens", { name: n, scope: scopeSelect.value }));
      if (!r.ok) return;
      name.value = "";
      showSecret(r.value.token, r.value.secret);
      await job.now();
    };
  });

  /** The secret, once, with a Copy button. @param {any} token @param {string} secret */
  const showSecret = (token, secret) => {
    const code = h("code", { class: "secret-value", tabindex: "0" }, secret);
    const copy = actionButton("Copy", { "aria-label": `Copy the secret of ${token.name}` }, async () => {
      try {
        await navigator.clipboard.writeText(secret);
        toast("Copied.");
      } catch {
        // No clipboard access (an http page on another host, a strict browser): select it for a manual copy.
        getSelection()?.selectAllChildren(code);
        toast("Select the secret and copy it by hand.", "info");
      }
    });
    const dismiss = actionButton("Done", null, async () => {
      secretBox.hidden = true;
      secretBox.replaceChildren();
      name.focus();
    });
    secretBox.replaceChildren(
      h("p", null, h("strong", null, `“${token.name}” created.`), " Copy its secret now: it is shown only this once."),
      h("div", { class: "row" }, code, copy, dismiss),
      h("p", { class: "hint" }, "Send it as ", h("code", null, "Authorization: Bearer <secret>"), " on the admin API."),
    );
    secretBox.hidden = false;
    copy.focus();
  };

  const intro = "A token lets an app or an AI agent use the admin API with one scope. Revoking it cuts it off at once. The same from the server's shell: izle-server token create <name> --scope <scope>, token list, token revoke <id>.";
  return page(
    { title: "Access" },
    scope.note,
    phonesCard(scope),
    card({ title: "Access tokens", intro }, listSlot.element),
    card("New token", secretBox, form),
  );
}
