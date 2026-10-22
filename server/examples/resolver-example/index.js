// @ts-check
// Example izle resolver module (resolver module API v1, see docs/spec/resolver-module-v1.md; walkthrough in
// README.md). It resolves `adapter: "example"` catalog sources against the local stand-in site, upstream.js.
//
// Server configuration:
//   "resolver": { "module": "./index.js", "config": { "apiBase": "http://127.0.0.1:8788/", "apiKey": "…" } }

/** @import { Adapter, AdapterContext, LanguageFacts, ResolveRequest, ResolveResult } from "@izle/contract" */

export const apiVersion = 1;

/** Thrown for unexpected upstream answers. Its message may contain a URL: izle records only the error's name. */
class UpstreamError extends Error {
  /** @override */
  name = "UpstreamError";
}

/**
 * What the example upstream's `/api/streams/<video>` returns.
 * @typedef {{ referer: string, expiresAt: string, url?: string, playlist?: string, baseUrl?: string,
 *   languages?: LanguageFacts }} StreamsAnswer
 */

/**
 * Called once at server start.
 * @param {AdapterContext} ctx
 * @returns {Adapter[]}
 */
export function createAdapters(ctx) {
  const { apiBase, apiKey } = ctx.config;
  if (typeof apiBase !== "string" || !/^https?:\/\//.test(apiBase)) throw new TypeError("config.apiBase must be an http(s) URL");
  if (typeof apiKey !== "string" || apiKey === "") throw new TypeError("config.apiKey is required");
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  const headers = { "X-Api-Key": apiKey, Accept: "application/json" };

  /**
   * Refs (see README.md) are opaque to izle. Every call asks the site anew and the same ref always gets the same
   * stream: izle resolves an episode again for the owner's phone, and a channel at `expiresAt`, after a 410 and after
   * a player error, each time from its live edge.
   * @param {ResolveRequest} req
   * @returns {Promise<ResolveResult[]>}
   */
  async function resolve(req) {
    const { video, format, inline, junkBytes, live } = req.ref;
    if (typeof video !== "string" || !/^[a-z0-9-]{1,64}$/.test(video)) throw new TypeError("ref.video must be a lowercase slug");
    // izle serves an inline playlist as it is for the whole session. A live one slides on, so it stays a URL, which
    // the proxy fetches anew on every request.
    if (live === true && inline === true) throw new TypeError("ref.inline does not go with ref.live");
    const kind = format === "mp4" || format === "ts" ? format : "hls";
    const url = new URL(`api/streams/${video}`, base);
    url.searchParams.set("format", kind);
    if (live === true) url.searchParams.set("live", "1");
    if (inline === true) url.searchParams.set("delivery", "inline");
    if (typeof junkBytes === "number") url.searchParams.set("junk", String(junkBytes));

    // Always pass the signal: it fires when the TV goes away or the deadline (req.deadlineMs) passes.
    const res = await ctx.fetch(url, { headers, signal: req.signal });
    if (res.status === 404) {
      // Nothing to play for this source right now; izle moves on to the episode's (or the channel's) next source.
      ctx.log("warn", "video not found upstream", { video, itemId: req.itemId, episodeId: req.episodeId });
      return [];
    }
    if (!res.ok) throw new UpstreamError(`upstream answered ${res.status} for ${url.href}`);
    const answer = /** @type {StreamsAnswer} */ (await res.json());
    const { playlist, baseUrl, referer, expiresAt, languages } = answer;
    /** @type {ResolveResult["media"]} */
    const media = playlist !== undefined && baseUrl !== undefined
      ? { kind: "hls", playlist, baseUrl }
      : { kind, url: /** @type {string} */ (answer.url) };
    // The Referer the site insists on. izle sees headers and proxies the stream; the TV never sees them.
    return [{ media, headers: { Referer: referer }, expiresAt, ...(languages && { languages }) }];
  }

  /** @param {AbortSignal} signal */
  async function healthcheck(signal) {
    const res = await ctx.fetch(new URL("api/health", base), { headers, signal });
    if (!res.ok) throw new UpstreamError(`health check answered ${res.status}`);
  }

  return [{ id: "example", resolve, healthcheck }];
}
