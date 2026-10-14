// @ts-check
// Sign in: the admin token is checked against `GET /admin/catalog`, then kept (localStorage, else for this tab).

import { isUnauthorized, signIn } from "./api.js";
import { h, onSubmit } from "./dom.js";
import { errorText } from "./lib.js";

/** @param {import("./router.js").Scope} scope */
export function loginView(scope) {
  const input = h("input", { type: "password", id: "token", autocomplete: "current-password", required: true, spellcheck: "false", "aria-describedby": "token-error" });
  const error = h("p", { class: "error", id: "token-error", role: "alert", hidden: true });
  const button = h("button", { type: "submit", class: "primary" }, "Sign in");
  const form = h(
    "form",
    { class: "card narrow" },
    h("h1", null, "Sign in"),
    h("p", null, "Paste the admin token of this izle server. Print it on the server with ", h("code", null, "izle-server admin-token"), "."),
    h("label", { for: "token" }, "Admin token"),
    input,
    error,
    h("div", { class: "actions" }, button),
  );
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
