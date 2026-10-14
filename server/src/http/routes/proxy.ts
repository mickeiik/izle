// The media proxy's routes. The token in the path is the credential: media requests carry no device token.

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { PROXY_TOKEN, type ProxyTarget } from "../../proxy.ts";
import type { Env } from "../middleware.ts";

export function registerProxy(app: Hono<Env>, ctx: AppContext): void {
  const proxyRoute = (target: (c: Context) => ProxyTarget) => (c: Context) => {
    const token = c.req.param("token") ?? "";
    if (!PROXY_TOKEN.test(token)) throw new HttpError(404, "not_found");
    return ctx.proxy.serve(c.req.raw, token, target(c));
  };
  app.get("/p/:token/index.m3u8", proxyRoute(() => ({ type: "index" })));
  app.get("/p/:token/video.mp4", proxyRoute(() => ({ type: "video" })));
  app.get("/p/:token/u/:ref", proxyRoute((c) => ({ type: "u", ref: c.req.param("ref") ?? "" })));
  app.get("/p/:token/sub/:file", proxyRoute((c) => ({ type: "sub", file: c.req.param("file") ?? "" })));
}
