// What the TV calls: pairing (unauthenticated; the approval is an admin route), then with its device token the
// home state, item details, resolve, progress, command acknowledgements and results, problem reports, the TV app
// APK on offer, and the event stream. Also the media proxy, whose token in the path is the only credential.

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { APK_MEDIA_TYPE } from "../../app-updates.ts";
import { bearerToken } from "../../auth.ts";
import type { AppContext } from "../../context.ts";
import { HttpError, unauthorized } from "../../errors.ts";
import { commandEvent, eventId, type ServerEvent } from "../../events.ts";
import { MAX_PAIR_WAIT_MS, PAIR_CODE } from "../../pairing.ts";
import { iso } from "../../presenters.ts";
import { PROXY_TOKEN, type ProxyTarget } from "../../proxy.ts";
import { commandResultBody, intParam, isId, parseBody, parseWait, problemBody, progressBody, resolveBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";

export function registerTv(app: Hono<Env>, ctx: AppContext, clientKey: (c: Context) => string): void {
  const { tv, pairing, events, notifier, appUpdates } = ctx;

  const proxyRoute = (target: (c: Context) => ProxyTarget) => (c: Context) => {
    const token = c.req.param("token") ?? "";
    if (!PROXY_TOKEN.test(token)) throw new HttpError(404, "not_found");
    return ctx.proxy.serve(c.req.raw, token, target(c));
  };
  app.get("/p/:token/index.m3u8", proxyRoute(() => ({ type: "index" })));
  app.get("/p/:token/video.mp4", proxyRoute(() => ({ type: "video" })));
  app.get("/p/:token/stream.ts", proxyRoute(() => ({ type: "stream" })));
  app.get("/p/:token/u/:ref", proxyRoute((c) => ({ type: "u", ref: c.req.param("ref") ?? "" })));
  app.get("/p/:token/sub/:file", proxyRoute((c) => ({ type: "sub", file: c.req.param("file") ?? "" })));

  app.post("/api/v1/pair/start", (c) => {
    const r = pairing.start(clientKey(c));
    return c.json({ code: r.code, pairToken: r.pairToken, expiresAt: iso(r.expiresAt) });
  });

  app.get("/api/v1/pair/wait", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!PAIR_CODE.test(code)) throw new HttpError(400, "invalid_request", "code must be 6 digits");
    const pairToken = bearerToken(c.req.header("Authorization"));
    if (!pairToken) throw unauthorized("izle-pair", "the pair token is required");
    const waitSec = parseWait(c.req.query("wait"), MAX_PAIR_WAIT_MS / 1000, MAX_PAIR_WAIT_MS / 1000);
    return c.json(await pairing.wait(code, pairToken, waitSec * 1000, c.req.raw.signal));
  });

  app.get("/api/v1/tv/state", (c) => c.json(tv.state(c.get("device"))));

  app.get("/api/v1/tv/items/:itemId", (c) => {
    const itemId = c.req.param("itemId");
    if (!isId(itemId)) throw new HttpError(404, "unknown_item");
    return c.json(tv.item(c.get("device"), itemId));
  });

  app.post("/api/v1/tv/resolve", async (c) => {
    const body = await parseBody(c, resolveBody);
    return c.json(await tv.resolve(c.get("device"), body, c.req.raw.signal));
  });

  app.post("/api/v1/tv/progress", async (c) => {
    const body = await parseBody(c, progressBody);
    return c.json({ ok: true, version: tv.recordProgress(c.get("device"), body).version });
  });

  const commandId = (c: Context) => intParam(c.req.param("id"), "unknown_command");

  app.post("/api/v1/tv/commands/:id/ack", (c) => {
    if (!ctx.commands.ack(c.get("device").id, commandId(c))) throw new HttpError(404, "unknown_command");
    return c.json({ ok: true });
  });

  // What the TV made of a command after acting on it (the ack came at once): reported once per command.
  app.post("/api/v1/tv/commands/:id/result", async (c) => {
    const id = commandId(c);
    const body = await parseBody(c, commandResultBody);
    const outcome = ctx.commands.report(c.get("device").id, id, body.result, body.reason ?? null);
    if (outcome === "unknown") throw new HttpError(404, "unknown_command");
    if (outcome === "already_reported") throw new HttpError(409, "already_reported", "this command's result is already reported");
    return c.json({ ok: true });
  });

  app.post("/api/v1/tv/problems", async (c) => {
    ctx.problems.report(c.get("device"), await parseBody(c, problemBody));
    return c.json({ ok: true }, 202);
  });

  app.get("/api/v1/tv/app", (c) => {
    const apk = appUpdates.current();
    if (!apk) return c.body(null, 204);
    const { versionName, versionCode, sha256, size } = apk;
    return c.json({ versionName, versionCode, sha256, size, auto: ctx.config.appUpdates.auto });
  });

  app.get("/api/v1/tv/app/apk", async (c) => {
    const headers = (sha256: string, size: number) => ({ "Content-Type": APK_MEDIA_TYPE, "Content-Length": String(size), ETag: `"${sha256}"`, "Cache-Control": "no-store" });
    if (c.req.method === "HEAD") {
      // No file is opened for a HEAD (its stream would never be read).
      const apk = appUpdates.current();
      if (!apk) throw new HttpError(404, "no_apk");
      return c.body(null, 200, headers(apk.sha256, apk.size));
    }
    const opened = await appUpdates.openApk();
    if (!opened) throw new HttpError(404, "no_apk");
    return c.body(opened.body, 200, headers(opened.apk.sha256, opened.size));
  });

  // On (re)connect: the state version, the stored APK as if it had just been stored, and the unacknowledged recent
  // commands; then state changes, new APKs and commands as they come.
  app.get("/api/v1/tv/events", (c) => {
    const device = c.get("device");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const message = (ev: ServerEvent) => ({ event: ev.type, data: JSON.stringify(ev.data), id: eventId(ev) });
      const write = (ev: ServerEvent) => stream.writeSSE(message(ev)).catch(() => stream.abort());
      const unsubscribe = events.subscribe(device.id, { send: (ev) => void write(ev), close: () => stream.abort() });
      try {
        await stream.writeSSE({ ...message({ type: "state", data: { version: notifier.version(device) } }), retry: 5000 });
        const apk = appUpdates.current();
        if (apk) await write({ type: "app", data: { versionCode: apk.versionCode } });
        for (const cmd of ctx.commands.replayable(device.id)) await write(commandEvent(cmd));
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });
}
