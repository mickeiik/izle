// @ts-check
// izle admin UI: a small single-page app over the admin API (docs/spec/server-api-v1.md). No dependencies, no
// build step, no inline scripts (the page is served with a strict Content-Security-Policy). All text from the
// server is inserted with textContent, never as HTML.
//
// This is the entry module (index.html loads it); it only boots the page. The parts, all flat in this directory
// (the server serves the files listed in server/src/admin-files.ts and nothing else):
//   router.js        hash routes and the view scope (polls, timers and requests that end with the view)
//   api.js           the admin API, the token, `attempt`        storage.js   guarded localStorage
//   dom.js           elements, cards, rows, buttons, toasts, focus  lib.js     pure helpers (unit-tested)
//   view-*.js        one module per view; device-home.js is the TV page's home screen card
//   companion.js     "Listen along" (its stream: companion-player.js)

import { ApiError, api, clearToken, getToken, onUnauthorized, setToken } from "./api.js";
import { toast } from "./dom.js";
import { errorText, tokenFromHash } from "./lib.js";
import { startRouter } from "./router.js";
import { catalogView } from "./view-catalog.js";
import { deviceView } from "./view-device.js";
import { devicesView } from "./view-devices.js";
import { itemView } from "./view-item.js";
import { loginView } from "./view-login.js";

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const nav = /** @type {HTMLElement} */ (document.getElementById("nav"));

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
    await api("GET", "/catalog", undefined, { token: linked });
  } catch (err) {
    toast(
      err instanceof ApiError && err.status === 401 ? "This sign-in link is not valid any more. Print a new one with izle-server admin-token --link." : errorText(err),
      "error",
    );
    return;
  }
  if (setToken(linked)) toast("Signed in.");
  else toast("Signed in for this tab only: this browser does not let the page remember the token.", "info");
}

startRouter({
  app,
  nav,
  before: signInFromLink,
  pick(parts) {
    if (!getToken() || parts[0] === "login") return { view: loginView };
    if (parts[0] === "devices" && parts[1]) {
      const id = parts[1];
      return { view: (scope) => deviceView(scope, id), nav: "#/devices" };
    }
    if (parts[0] === "catalog" && parts[1] === "items" && parts[2]) {
      const id = parts[2];
      return { view: (scope) => itemView(scope, id), nav: "#/catalog" };
    }
    if (parts[0] === "catalog") return { view: catalogView, nav: "#/catalog" };
    return { view: devicesView, nav: "#/devices" };
  },
});

/** @type {HTMLButtonElement} */ (document.getElementById("signout")).addEventListener("click", () => signOut());

// The skip link moves the focus to the view's heading; following its `#app` would re-run the router.
document.querySelector(".skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  const target = /** @type {HTMLElement | null} */ (app.querySelector("h1")) ?? app;
  target.tabIndex = -1;
  target.focus();
});
