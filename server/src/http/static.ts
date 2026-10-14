// Health check, posters and the admin page's static files (an allow-list, served under a strict CSP).

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { ADMIN_FILES, ADMIN_VENDOR_FILES } from "../admin-files.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../errors.ts";
import type { Env } from "./middleware.ts";

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

// media-src: the "Listen along" audio element plays companion streams through the same-origin proxy, and
// blob: object URLs when hls.js feeds it through Media Source Extensions (page-local, nothing is fetched).
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** A file's bytes; 404 `not_found` when it cannot be read. */
async function readOr404(file: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    throw new HttpError(404, "not_found");
  }
}

/** The content type an allow-list gives a file name (own entries only: `__proto__` is no file). */
const allowedType = (list: Record<string, string>, file: string): string | undefined => (Object.hasOwn(list, file) ? list[file] : undefined);

export function registerStatic(app: Hono<Env>, ctx: AppContext): void {
  const { catalog } = ctx;

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.redirect("/admin/"));

  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const abs = catalog.assetPath(file);
    if (!abs) throw new HttpError(404, "not_found");
    const bytes = await readOr404(abs);
    const ext = file.slice(file.lastIndexOf(".") + 1);
    return c.body(bytes, 200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${file.slice(0, 64)}"`,
    });
  });

  const adminFile = async (c: Context, file: string, type: string) => {
    const bytes = await readOr404(path.join(ctx.adminUiDir, file));
    return c.body(bytes, 200, { "Content-Type": type, "Cache-Control": "no-cache", "Content-Security-Policy": ADMIN_CSP });
  };
  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/", (c) => adminFile(c, "index.html", "text/html; charset=utf-8"));
  app.get("/admin/:file", (c) => {
    const file = c.req.param("file");
    const type = allowedType(ADMIN_FILES, file);
    if (!type) throw new HttpError(404, "not_found");
    return adminFile(c, file, type);
  });
  app.get("/admin/vendor/:file", (c) => {
    const file = c.req.param("file");
    const type = allowedType(ADMIN_VENDOR_FILES, file);
    if (!type) throw new HttpError(404, "not_found");
    return adminFile(c, path.join("vendor", file), type);
  });
}
