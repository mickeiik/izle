/**
 * The admin page's static files, served from `server/admin/` with their content types. This is an allow-list:
 * nothing else in the directory is served. The packaging script copies every top-level `.html`/`.js`/`.css`/`.svg`
 * file of the directory, so a file added here only needs to exist there.
 */
export const ADMIN_FILES: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "router.js": "text/javascript; charset=utf-8",
  "api.js": "text/javascript; charset=utf-8",
  "storage.js": "text/javascript; charset=utf-8",
  "dom.js": "text/javascript; charset=utf-8",
  "lib.js": "text/javascript; charset=utf-8",
  "view-login.js": "text/javascript; charset=utf-8",
  "view-devices.js": "text/javascript; charset=utf-8",
  "view-device.js": "text/javascript; charset=utf-8",
  "device-home.js": "text/javascript; charset=utf-8",
  "view-catalog.js": "text/javascript; charset=utf-8",
  "view-item.js": "text/javascript; charset=utf-8",
  "companion.js": "text/javascript; charset=utf-8",
  "companion-player.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

/** Third-party files vendored under `server/admin/vendor/` (pinned builds; see the README there). */
export const ADMIN_VENDOR_FILES: Record<string, string> = {
  "hls.min.js": "text/javascript; charset=utf-8",
};
