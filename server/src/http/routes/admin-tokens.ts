// The access tokens (owner token only): list, create (the secret is in this answer and nowhere else), revoke.

import type { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { accessTokenJson } from "../../tokens.ts";
import { isId, parseBody, tokenBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";

export function registerAdminTokens(app: Hono<Env>, { tokens }: AppContext): void {
  app.get("/api/v1/admin/tokens", (c) => c.json({ tokens: tokens.list().map(accessTokenJson) }));

  app.post("/api/v1/admin/tokens", async (c) => {
    const body = await parseBody(c, tokenBody);
    const { token, secret } = tokens.create(body.name, body.scope);
    return c.json({ token: accessTokenJson(token), secret }, 201);
  });

  app.delete("/api/v1/admin/tokens/:id", (c) => {
    const id = c.req.param("id");
    if (!isId(id)) throw new HttpError(404, "unknown_token");
    tokens.revoke(id);
    return c.body(null, 204);
  });
}
