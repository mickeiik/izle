// Pairing, the TV side (unauthenticated): a code to show, then a long-poll that hands over the device token once
// the owner approved it. The approval itself is an admin route (admin-devices.ts).

import type { Context, Hono } from "hono";
import { bearerToken } from "../../auth.ts";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { MAX_PAIR_WAIT_MS, PAIR_CODE } from "../../pairing.ts";
import { iso } from "../../presenters.ts";
import type { Env } from "../middleware.ts";
import { parseWait } from "../params.ts";

export function registerPairing(app: Hono<Env>, ctx: AppContext, clientKey: (c: Context) => string): void {
  const { pairing } = ctx;

  app.post("/api/v1/pair/start", (c) => {
    const r = pairing.start(clientKey(c));
    return c.json({ code: r.code, pairToken: r.pairToken, expiresAt: iso(r.expiresAt) });
  });

  app.get("/api/v1/pair/wait", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!PAIR_CODE.test(code)) throw new HttpError(400, "invalid_request", "code must be 6 digits");
    const pairToken = bearerToken(c.req.header("Authorization"));
    if (!pairToken) throw new HttpError(401, "unauthorized", "the pair token is required", {}, { "WWW-Authenticate": 'Bearer realm="izle-pair"' });
    const waitSec = parseWait(c.req.query("wait"), MAX_PAIR_WAIT_MS / 1000, MAX_PAIR_WAIT_MS / 1000);
    const r = await pairing.wait(code, pairToken, waitSec * 1000, c.req.raw.signal);
    return c.json(r);
  });
}
