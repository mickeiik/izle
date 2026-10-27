// The owner's phones: a TV creates an invite, long-polls it and cancels it when it leaves the screen, a phone claims
// it without a token (the invite or its code is the credential), and the owner level lists and disconnects them.

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { iso } from "../../presenters.ts";
import { MAX_INVITE_WAIT_MS, phoneJson } from "../../phones.ts";
import { claimBody, isId, parseBody, parseWait } from "../../validation.ts";
import type { Env } from "../middleware.ts";

export function registerPhones(app: Hono<Env>, { phones }: AppContext, clientKey: (c: Context) => string): void {
  app.post("/api/v1/tv/phones/invite", (c) => {
    const r = phones.invite(c.get("device"));
    return c.json({ code: r.code, invite: r.invite, expiresAt: iso(r.expiresAt) });
  });

  app.get("/api/v1/tv/phones/invite", async (c) => {
    const waitSec = parseWait(c.req.query("wait"), MAX_INVITE_WAIT_MS / 1000, MAX_INVITE_WAIT_MS / 1000);
    return c.json(await phones.wait(c.get("device").id, waitSec * 1000, c.req.raw.signal));
  });

  app.delete("/api/v1/tv/phones/invite", (c) => {
    phones.cancel(c.get("device").id);
    return c.body(null, 204);
  });

  app.post("/api/v1/phones/claim", async (c) => {
    const body = await parseBody(c, claimBody);
    const { phone, secret, deviceId } = phones.claim(clientKey(c), body);
    return c.json({ phone: phoneJson(phone), secret, deviceId }, 201);
  });

  app.get("/api/v1/admin/phones", (c) => c.json({ phones: phones.list().map(phoneJson) }));

  app.delete("/api/v1/admin/phones/:id", (c) => {
    const id = c.req.param("id");
    if (!isId(id)) throw new HttpError(404, "not_found", "no phone with this id");
    phones.remove(id, c.get("actor"));
    return c.body(null, 204);
  });
}
