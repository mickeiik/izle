// @ts-check
// The TV app: the APK the server offers to the TVs (fetched from the GitHub releases or uploaded here), a new one
// uploaded, and every TV with its installed version and "Install now". A server without TV app updates (404) says so
// and offers nothing.

import { ApiError, api, attempt, sendCommand, upload } from "./api.js";
import { actionButton, card, chip, factRows, h, keyedRows, onSubmit, page, setChip, setOff, slot, toast, uid } from "./dom.js";

import { watchEvents } from "./events.js";
import {
  APK_MAX_BYTES, androidText, apkVersion, appCheckText, appUpdateChip, checkResultText, commandResultText, errorText,
  formatBytes, formatRelative, installNowBlocked, newApkText,
} from "./lib.js";

const GUIDED = "Someone at the TV has to press OK when the screen appears.";

/** @param {import("./router.js").Scope} scope */
export function appView(scope) {
  /** `GET /admin/app`; null before it loaded and on a server without TV app updates. @type {any} */
  let app = null;
  let unsupported = false;
  /** Device names by id, for the command result toasts. @type {Map<string, string>} */
  const names = new Map();

  const storedSlot = slot();
  const oldServer = h("div", { class: "callout info" }, h("p", null, "This server has no TV app updates. Update izle-server to offer the TV app to the TVs from here."));
  const none = h("p", { class: "muted" });
  const facts = h("dl", { class: "facts" });
  const origin = h("p", { class: "muted" });
  const autoLine = h("p", { class: "muted" });
  const checkLine = h("p", { class: "muted" });
  const checkHint = h("p", { class: "hint", id: "app-check-hint" });
  const check = actionButton("Check now", { "aria-describedby": "app-check-hint" }, async () => {
    const r = await attempt(() => api("POST", "/app/check"));
    if (r.ok) {
      const t = checkResultText(r.value, Boolean(app?.auto));
      toast(t.text, t.kind);
    }
    await job.now();
  });
  const remove = actionButton("Remove", { class: "danger", "aria-label": "Remove the stored TV app" }, async () => {
    if (!app?.apk) return;
    const again = app.source === "github" ? " The next check fetches the latest release again." : "";
    if (!confirm(`Remove the stored TV app ${app.apk.versionName}? The TVs keep the version they have; nothing is offered to them until another APK is stored.${again}`)) return;
    const r = await attempt(() => api("DELETE", "/app/apk"), "The stored TV app was removed.");
    if (r.ok) await job.now();
  });
  const storedActions = h("div", { class: "actions" }, check, remove);

  const showStored = () => {
    if (unsupported || !app) return storedSlot.show(oldServer);
    const apk = app.apk;
    const github = app.source === "github";
    none.hidden = Boolean(apk);
    none.textContent = github
      ? `No TV app is stored yet. The server fetches the latest release of ${app.repo} on its next check, or now with Check now.`
      : "No TV app is stored yet. Upload the release APK below.";
    facts.hidden = !apk;
    if (apk) {
      const stored = `${formatRelative(apk.storedAt)} · ${new Date(apk.storedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
      facts.replaceChildren(...factRows([
        ["Version", `${apk.versionName} (code ${apk.versionCode})`],
        ["Source", apk.source === "github" ? `GitHub release ${apk.releaseTag ?? apk.versionName}` : "uploaded here"],
        ["Size", formatBytes(apk.size)],
        ["Stored", stored],
        ["SHA-256", h("code", { class: "hash" }, apk.sha256)],
      ]));
    }
    const every = Number.isInteger(app.checkIntervalHours) ? `every ${app.checkIntervalHours} h` : "on a schedule";
    origin.textContent = github
      ? `New versions come from the GitHub releases of ${app.repo}, checked ${every} and with Check now.`
      : "New versions come only from uploads (the server's app source is manual).";
    autoLine.textContent = app.auto
      ? "Automatic installs are on: TVs that can install by themselves do so when idle."
      : "Automatic installs are off: every TV needs Install now.";
    checkLine.textContent = appCheckText(app.check, app.source);
    checkLine.hidden = checkLine.textContent === "";
    const running = Boolean(app.check?.running);
    setOff(check, app.source === "manual" || running);
    checkHint.textContent = app.source === "manual"
      ? "Checks are off: this server is set to uploaded APKs only."
      : running ? "A check is running." : "Looks for a newer release on GitHub now.";
    setOff(remove, !apk);
    storedSlot.show(none, facts, origin, autoLine, checkLine, storedActions, checkHint);
  };

  const file = h("input", { type: "file", id: "apk-file", accept: ".apk,application/vnd.android.package-archive", "aria-describedby": "apk-hint apk-status" });
  const hint = h("p", { class: "hint", id: "apk-hint" },
    "Use the release APK from GitHub, named izle-tv-X.Y.Z.apk as on the releases page: only a release-signed APK installs over the app on the TVs (a debug build is signed with a throwaway key).");
  const status = h("p", { class: "hint", id: "apk-status", role: "status" });
  const send = h("button", { type: "submit", class: "primary" }, "Upload");
  const form = h("form", { class: "form" }, h("label", { for: "apk-file" }, "APK file"), file, hint, status, h("div", { class: "actions" }, send));
  const setStatus = (/** @type {string} */ text, error = false) => {
    status.textContent = text;
    status.className = error ? "hint error" : "hint";
  };
  /** What is wrong with the chosen file, or null. @param {File | undefined} f */
  const problem = (f) => {
    if (!f) return null;
    if (apkVersion(f.name) === null) return `“${f.name}” is not named like a release APK: name it izle-tv-X.Y.Z.apk, as on the releases page.`;
    return f.size > APK_MAX_BYTES ? `That file is ${formatBytes(f.size)}; the server takes at most 64 MiB.` : null;
  };
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    const p = problem(f);
    setStatus(p ?? (f ? `Version ${apkVersion(f.name)} · ${formatBytes(f.size)}` : ""), p !== null);
  });
  onSubmit(form, send, () => {
    const f = file.files?.[0];
    if (!f) return toast("Choose an APK first.", "info");
    const p = problem(f);
    if (p) {
      setStatus(p, true);
      return file.focus();
    }
    return async () => {
      setStatus(`Uploading ${f.name} (${formatBytes(f.size)})…`);
      const r = await attempt(() => upload("/app/apk", f));
      if (!r.ok) return setStatus(errorText(r.error), true);
      setStatus("");
      file.value = "";
      toast(`Uploaded ${r.value.apk.versionName}. ${newApkText(Boolean(app?.auto))}`);
      await job.now();
    };
  });
  const uploadCard = card({ title: "Upload an APK", intro: "Replaces the stored app, for example with a release the server cannot fetch by itself." }, form);

  const devicesSlot = slot();
  const list = h("div", { class: "list" });
  const empty = h("p", { class: "muted" }, "No TV is paired yet.");

  /** @param {any} d */
  const deviceRow = (d) => {
    const link = h("a", { href: `#/devices/${encodeURIComponent(d.id)}` });
    const meta = h("div", { class: "muted" });
    const state = chip("");
    const why = h("span", { class: "visually-hidden", id: uid("install-why") });
    let current = d;
    const install = actionButton("Install now", { "data-control": "install", "aria-describedby": why.id }, () => {
      const guided = current.app?.capability === "guided" ? ` ${GUIDED}` : "";
      return sendCommand(current.id, { type: "update" }, "Install now", `“${current.name}”`, guided);
    });
    const guided = h("p", { class: "hint" }, GUIDED);
    return {
      element: h("div", null, h("div", { class: "row" }, h("div", { class: "grow" }, h("strong", null, link), meta), state, install, why), guided),
      /** @param {any} next */
      update(next) {
        current = next;
        link.textContent = next.name;
        install.setAttribute("aria-label", `Install now on ${next.name}`);
        const a = next.app;
        const parts = [a?.version ? `app ${a.version}` : "app version unknown"];
        if (a?.androidSdk !== null && a?.androidSdk !== undefined) parts.push(androidText(a.androidSdk));
        if (!next.online) parts.push("offline");
        meta.textContent = parts.join(" · ");
        const c = appUpdateChip(a);
        setChip(state, c.text, c.tone);
        const blocked = unsupported ? "This server has no TV app updates." : installNowBlocked(next, Boolean(app?.apk));
        setOff(install, blocked !== null);
        why.textContent = blocked ?? "";
        guided.hidden = a?.capability !== "guided";
      },
    };
  };
  const rows = keyedRows(list, (/** @type {any} */ d) => d.id, deviceRow);

  const refresh = async () => {
    const [a, devices] = await Promise.all([
      scope.read("/app").catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null; // a server without TV app updates
        throw err;
      }),
      scope.read("/devices"),
    ]);
    unsupported = a === null;
    app = a;
    uploadCard.hidden = unsupported;
    showStored();
    for (const d of devices.devices) names.set(d.id, d.name);
    rows.set(devices.devices);
    empty.hidden = devices.devices.length > 0;
    devicesSlot.show(empty, list);
    // A check running in the background: look again soon rather than at the next poll.
    if (app?.check?.running) scope.later(() => void job.now(), 3000);
  };
  const job = scope.poll(refresh, 15_000, (err) => {
    storedSlot.fail(err, job.now, "Could not load the TV app.");
    devicesSlot.fail(err, null, "Could not load the TVs.");
  });
  watchEvents(scope, { types: ["app.", "device.", "command.result"] }, (e) => {
    if (e.type === "command.result" && e.data?.type === "update") {
      const name = names.get(e.deviceId);
      toast(`${name ? `${name}: ` : ""}${commandResultText(e.data)}`, e.data.result === "done" ? "ok" : "info");
    }
    if (e.type !== "command.result" || e.data?.type === "update") void job.now();
  });

  const intro = "The APK the server offers to the TVs. With automatic installs on, TVs on Android 12 or newer install it by themselves while nobody is watching; the others need Install now below.";
  return page(
    { title: "TV app" },
    scope.note,
    card({ title: "Stored app", intro }, storedSlot.element),
    uploadCard,
    card({ title: "TVs", intro: "Each TV's installed version. Install now asks a TV to update at once." }, devicesSlot.element),
  );
}
