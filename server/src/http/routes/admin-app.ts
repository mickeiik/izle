// The TV app APK the server offers its TVs (admin API): what is stored and where it comes from, an upload by the
// owner (the one route whose body may exceed the API's 64 KiB, streamed to disk with its own cap), removal, and a
// GitHub check on demand.

import type { Hono } from "hono";
import { APK_MEDIA_TYPE, ApkRejected, apkJson, parseApkName } from "../../app-updates.ts";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import type { Env } from "../middleware.ts";

export function registerAdminApp(app: Hono<Env>, ctx: AppContext): void {
  const { appUpdates } = ctx;

  app.get("/api/v1/admin/app", (c) => {
    const apk = appUpdates.current();
    const { source, repo, auto } = appUpdates.config;
    return c.json({ apk: apk && apkJson(apk), source, repo, auto, check: appUpdates.checkStatus() });
  });

  app.put("/api/v1/admin/app/apk", async (c) => {
    const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== APK_MEDIA_TYPE) throw new HttpError(400, "unsupported_media_type", `the body must be ${APK_MEDIA_TYPE}`);
    const name = c.req.header("X-Izle-Filename") ?? c.req.query("name") ?? "";
    if (!parseApkName(name)) throw new HttpError(400, "invalid_filename", "the file name must be izle-tv-X.Y.Z.apk");
    const tooLarge = () => new HttpError(413, "apk_too_large", "the APK is larger than the server stores", { maxBytes: appUpdates.maxBytes });
    if (Number(c.req.header("Content-Length")) > appUpdates.maxBytes) throw tooLarge();
    try {
      const apk = await appUpdates.store(c.req.raw.body, name, "upload", null, c.get("actor"));
      return c.json({ apk: apkJson(apk) });
    } catch (err) {
      if (!(err instanceof ApkRejected)) throw err;
      if (err.reason === "too_large") throw tooLarge();
      throw new HttpError(400, err.reason === "invalid_filename" ? "invalid_filename" : "not_an_apk", "the body is not an APK");
    }
  });

  app.delete("/api/v1/admin/app/apk", (c) => {
    if (!appUpdates.remove(c.get("actor"))) throw new HttpError(404, "no_apk");
    return c.body(null, 204);
  });

  app.post("/api/v1/admin/app/check", async (c) => {
    const { result, reason, apk } = await appUpdates.check(c.get("actor"));
    return c.json({ result, reason, apk: apk && apkJson(apk) });
  });
}
