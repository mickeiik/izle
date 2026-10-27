// Health check, posters, the pictures of the TVs' apps, and the static files of the admin page and of the `/connect` page a phone opens from the QR
// code a TV shows (allow-lists, served under a strict CSP, without authentication).

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { ADMIN_FILES, ADMIN_VENDOR_FILES, CONNECT_FILES } from "../admin-files.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../errors.ts";
import type { Env } from "./middleware.ts";

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const HTML = { "index.html": "text/html; charset=utf-8" };

// media-src: "Listen along" plays companion streams through the same-origin proxy, and blob: object URLs when
// hls.js feeds it through Media Source Extensions.
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function readOr404(file: string | null): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (file) return new Uint8Array(await readFile(file));
  } catch {
    // unreadable: not found
  }
  throw new HttpError(404, "not_found");
}

export function registerStatic(app: Hono<Env>, ctx: AppContext): void {
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.redirect("/admin/"));

  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const bytes = await readOr404(ctx.catalog.assetPath(file));
    return c.body(bytes, 200, {
      "Content-Type": CONTENT_TYPES[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${file.slice(0, 64)}"`,
    });
  });

  // The pictures of the TVs' apps, content-addressed and public like the posters.
  app.get("/app-images/:file", (c) => {
    const file = c.req.param("file");
    const png = ctx.apps.image(file);
    if (!png) throw new HttpError(404, "not_found");
    return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${file.slice(0, 64)}"` });
  });

  /** A file of an allow-list (own entries only: `__proto__` is no file). */
  const staticFile = async (c: Context, dir: string, file: string, list: Record<string, string>) => {
    if (!Object.hasOwn(list, file)) throw new HttpError(404, "not_found");
    const bytes = await readOr404(path.join(dir, file));
    return c.body(bytes, 200, { "Content-Type": list[file]!, "Cache-Control": "no-cache", "Content-Security-Policy": ADMIN_CSP });
  };
  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/", (c) => staticFile(c, ctx.adminUiDir, "index.html", HTML));
  app.get("/admin/:file", (c) => staticFile(c, ctx.adminUiDir, c.req.param("file"), ADMIN_FILES));
  app.get("/admin/vendor/:file", (c) => staticFile(c, path.join(ctx.adminUiDir, "vendor"), c.req.param("file"), ADMIN_VENDOR_FILES));
  // The invite is in the URL's fragment, which browsers never send: the page reads it and hands it to the app.
  app.get("/connect", (c) => staticFile(c, ctx.connectDir, "index.html", HTML));
  app.get("/connect/:file", (c) => staticFile(c, ctx.connectDir, c.req.param("file"), CONNECT_FILES));
}
