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
 * @typedef {object} StreamsAnswer what the example upstream's `/api/streams/<video>` returns
 * @property {string} referer
 * @property {string} expiresAt
 * @property {string} [url]
 * @property {string} [playlist]
 * @property {string} [baseUrl]
 * @property {LanguageFacts} [languages]
 */

/**
 * Called once at server start.
 * @param {AdapterContext} ctx
 * @returns {Adapter[]}
 */
export function createAdapters(ctx) {
  const { apiBase, apiKey: key } = ctx.config;
  if (typeof apiBase !== "string" || !/^https?:\/\//.test(apiBase)) throw new TypeError("config.apiBase must be an http(s) URL");
  if (typeof key !== "string" || key === "") throw new TypeError("config.apiKey is required");
  const apiKey = key; // narrowed for the functions below
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;

  /**
   * Refs (opaque to izle): `{ video }` HLS by signed URL; plus `inline: true` for the master playlist text instead
   * of a URL, `format: "mp4"` for a progressive MP4, `junkBytes: <n>` for segments prefixed with junk bytes.
   * @param {ResolveRequest} req
   * @returns {Promise<ResolveResult[]>}
   */
  async function resolve(req) {
    const { video, format, inline, junkBytes } = req.ref;
    if (typeof video !== "string" || !/^[a-z0-9-]{1,64}$/.test(video)) throw new TypeError("ref.video must be a lowercase slug");
    const mp4 = format === "mp4";
    const url = new URL(`api/streams/${video}`, base);
    url.searchParams.set("format", mp4 ? "mp4" : "hls");
    if (inline === true) url.searchParams.set("delivery", "inline");
    if (typeof junkBytes === "number") url.searchParams.set("junk", String(junkBytes));

    // Always pass the signal: it fires when the TV goes away or the deadline (req.deadlineMs) passes.
    const res = await ctx.fetch(url, { headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: req.signal });
    if (res.status === 404) {
      // Nothing to play for this source right now; izle moves on to the episode's next source.
      ctx.log("warn", "video not found upstream", { video, episodeId: req.episodeId });
      return [];
    }
    if (!res.ok) throw new UpstreamError(`upstream answered ${res.status} for ${url.href}`);
    const answer = /** @type {StreamsAnswer} */ (await res.json());

    /** @type {ResolveResult} */
    const result = {
      media:
        answer.playlist !== undefined && answer.baseUrl !== undefined
          ? { kind: "hls", playlist: answer.playlist, baseUrl: answer.baseUrl }
          : { kind: mp4 ? "mp4" : "hls", url: /** @type {string} */ (answer.url) },
      // The Referer the site insists on. izle sees headers and proxies the stream; the TV never sees them.
      headers: { Referer: answer.referer },
      expiresAt: answer.expiresAt,
    };
    if (answer.languages) result.languages = answer.languages;
    return [result];
  }

  /** @param {AbortSignal} signal */
  async function healthcheck(signal) {
    const res = await ctx.fetch(new URL("api/health", base), { headers: { "X-Api-Key": apiKey }, signal });
    if (!res.ok) throw new UpstreamError(`health check answered ${res.status}`);
  }

  return [{ id: "example", resolve, healthcheck }];
}
