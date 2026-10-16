// @ts-check
// izle admin UI: a small single-page app over the admin API, without dependencies or a build step. The page is
// served with a strict Content-Security-Policy: no inline scripts or styles, and text from the server is only ever
// inserted as text. This entry module boots the page and holds the sign-in view.

import { clearToken, getToken, isUnauthorized, onUnauthorized, signIn } from "./api.js";
import { h, onSubmit, toast } from "./dom.js";
import { errorText, tokenFromHash } from "./lib.js";
import { startRouter } from "./router.js";
import { catalogView } from "./view-catalog.js";
import { deviceView } from "./view-device.js";
import { devicesView } from "./view-devices.js";
import { historyItemView, historyView } from "./view-history.js";
import { itemView } from "./view-item.js";
import { tokensView } from "./view-tokens.js";

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

function signOut(/** @type {string} */ message = "") {
  clearToken();
  location.hash = "#/login";
  if (message) toast(message, "info");
}
onUnauthorized(() => signOut("Your admin token is not valid any more. Sign in again."));

/** A sign-in link (`#token=…`) signs the browser in; the token leaves the address bar and history first. */
async function signInFromLink() {
  const linked = tokenFromHash(location.hash);
  if (!linked) return;
  history.replaceState(null, "", `${location.pathname}${location.search}#/devices`);
  try {
    if (await signIn(linked)) toast("Signed in.");
  } catch (err) {
    toast(isUnauthorized(err) ? "This sign-in link is not valid any more. Print a new one with izle-server admin-token --link." : errorText(err), "error");
  }
}

/** @param {import("./router.js").Scope} scope */
function loginView(scope) {
  const input = h("input", { type: "password", id: "token", autocomplete: "current-password", required: true, spellcheck: "false", "aria-describedby": "token-error" });
  const error = h("p", { class: "error", id: "token-error", role: "alert", hidden: true });
  const button = h("button", { type: "submit", class: "primary" }, "Sign in");
  const intro = h("p", null, "Paste the admin token of this izle server. Print it on the server with ", h("code", null, "izle-server admin-token"), ".");
  const form = h("form", { class: "card narrow" }, h("h1", null, "Sign in"), intro, h("label", { for: "token" }, "Admin token"), input, error, h("div", { class: "actions" }, button));
  onSubmit(form, button, () => {
    const value = input.value.trim();
    return async () => {
      try {
        await signIn(value);
      } catch (err) {
        error.hidden = false;
        error.textContent = isUnauthorized(err) ? "That token is not valid." : errorText(err);
        input.focus();
        return;
      }
      scope.go("#/devices");
    };
  });
  queueMicrotask(() => input.focus());
  return h("div", { class: "page" }, form);
}

startRouter({
  app,
  nav: /** @type {HTMLElement} */ (document.getElementById("nav")),
  before: signInFromLink,
  pick([section, id, itemId]) {
    if (!getToken() || section === "login") return { view: loginView };
    if (section === "devices" && id) return { view: (scope) => deviceView(scope, id), nav: "#/devices" };
    if (section === "catalog" && id === "items" && itemId) return { view: (scope) => itemView(scope, itemId), nav: "#/catalog" };
    if (section === "catalog") return { view: catalogView, nav: "#/catalog" };
    if (section === "history" && id) return { view: (scope) => historyItemView(scope, id), nav: "#/history" };
    if (section === "history") return { view: historyView, nav: "#/history" };
    if (section === "tokens") return { view: tokensView, nav: "#/tokens" };
    return { view: devicesView, nav: "#/devices" };
  },
});

/** @type {HTMLElement} */ (document.getElementById("signout")).addEventListener("click", () => signOut());

// The skip link moves the focus to the view's heading; following its `#app` would re-run the router.
document.querySelector(".skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  const target = /** @type {HTMLElement | null} */ (app.querySelector("h1")) ?? app;
  target.tabIndex = -1;
  target.focus();
});
