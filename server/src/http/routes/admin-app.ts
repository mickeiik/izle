// The TV app APK the server offers its TVs: what is stored and where it comes from, the owner's upload (streamed
// to disk with its own size cap), removal, and a GitHub check on demand.

import type { Hono } from "hono";
import { APK_MEDIA_TYPE, ApkRejected, apkJson, parseApkName } from "../../app-updates.ts";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import type { Env } from "../middleware.ts";

export function registerAdminApp(app: Hono<Env>, ctx: AppContext): void {
  const { appUpdates } = ctx;

  app.get("/api/v1/admin/app", (c) => {
    const apk = appUpdates.current();
    const { source, repo, auto, checkIntervalHours } = appUpdates.config;
    return c.json({ apk: apk && apkJson(apk), source, repo, auto, checkIntervalHours, check: appUpdates.checkStatus() });
  });

  app.put("/api/v1/admin/app/apk", async (c) => {
    const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== APK_MEDIA_TYPE) throw new HttpError(400, "unsupported_media_type", `the body must be ${APK_MEDIA_TYPE}`);
    const name = c.req.header("X-Izle-Filename") ?? c.req.query("name") ?? "";
    if (!parseApkName(name)) throw new HttpError(400, "invalid_filename", "the file name must be izle-tv-X.Y.Z.apk");
    const tooLarge = () => new HttpError(413, "apk_too_large", "the APK is larger than the server stores", { maxBytes: appUpdates.maxBytes });
    if (Number(c.req.header("Content-Length")) > appUpdates.maxBytes) throw tooLarge();
    const body = c.req.raw.body;
    try {
      return c.json({ apk: apkJson(await appUpdates.store(body, name, "upload", null, c.get("actor"))) });
    } catch (err) {
      if (!(err instanceof ApkRejected)) throw err;
      // The rest of the body is read, so the client (still sending) gets the answer instead of a dropped connection.
      await drain(body, appUpdates.maxBytes);
      if (err.reason === "too_large") throw tooLarge();
      throw new HttpError(400, err.reason === "invalid_filename" ? "invalid_filename" : "not_an_apk", "the body is not an APK");
    }
  });

  app.delete("/api/v1/admin/app/apk", async (c) => {
    if (!(await appUpdates.remove(c.get("actor")))) throw new HttpError(404, "no_apk");
    return c.body(null, 204);
  });

  app.post("/api/v1/admin/app/check", async (c) => {
    const { result, reason, apk } = await appUpdates.check(c.get("actor"));
    return c.json({ result, reason, apk: apk && apkJson(apk) });
  });
}

/** Reads and drops at most `max` more bytes of a request body, then cancels it. */
async function drain(body: ReadableStream<Uint8Array> | null, max: number): Promise<void> {
  if (!body || body.locked) return;
  const reader = body.getReader();
  try {
    for (let left = max; left > 0; ) {
      const { value, done } = await reader.read();
      if (done) return;
      left -= value.byteLength;
    }
  } catch {
    // The client went away.
  } finally {
    await reader.cancel().catch(() => {});
  }
}
