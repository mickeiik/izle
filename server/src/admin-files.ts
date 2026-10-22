const JS = "text/javascript; charset=utf-8";
const MODULES = ["app.js", "router.js", "api.js", "dom.js", "lib.js", "view-devices.js", "view-device.js",
  "device-home.js", "catalog-browser.js", "view-catalog.js", "view-item.js", "view-history.js", "view-tokens.js", "view-app.js", "events.js", "companion.js", "companion-player.js"];

/**
 * The admin page's static files, served from `server/admin/` with their content types. This is an allow-list:
 * nothing else in the directory is served. The packaging script copies every top-level `.html`/`.js`/`.css`/`.svg`
 * file of the directory, so a file added here only needs to exist there.
 */
export const ADMIN_FILES: Record<string, string> = {
  ...Object.fromEntries(MODULES.map((f) => [f, JS])),
  "style.css": "text/css; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

/** Third-party files vendored under `server/admin/vendor/` (pinned builds; see the README there). */
export const ADMIN_VENDOR_FILES: Record<string, string> = { "hls.min.js": JS };
