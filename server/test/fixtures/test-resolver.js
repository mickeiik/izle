// @ts-check
// Resolver module for the server tests: the example module's adapters plus a "test" adapter whose behaviour is
// chosen by the source ref, including hostile ones (hangs, throws with secrets in the message, invalid results).

/** @import { Adapter, AdapterContext, ResolveRequest, ResolveResult } from "@izle/contract" */
import * as example from "../../examples/resolver-example/index.js";

export const apiVersion = 1;

/** Signals seen by `hang-signal` calls, so tests can check that the deadline aborted them. */
export const seenSignals = /** @type {AbortSignal[]} */ ([]);

const SECRET_URL = "https://signed.secret.example.test/master.m3u8?token=SuperSecretToken0123456789abcdef";

/** @param {AdapterContext} ctx @returns {Adapter} */
function testAdapter(ctx) {
  /** @param {ResolveRequest} req @returns {Promise<ResolveResult[]>} */
  const resolve = (req) => {
    const ref = /** @type {Record<string, any>} */ (req.ref);
    switch (ref.behavior) {
      case "hang":
        return new Promise(() => {}); // ignores the signal entirely
      case "hang-signal":
        seenSignals.push(req.signal);
        return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
      case "throw":
        return Promise.reject(Object.assign(new Error(`upstream 500 for ${SECRET_URL}`), { name: "LeakyError" }));
      case "throw-sync":
        throw new RangeError(`bad ref ${SECRET_URL}`);
      case "invalid":
        return Promise.resolve(/** @type {any} */ ([{ media: { kind: "hls", url: "not a url" }, headers: { Referer: SECRET_URL } }]));
      case "not-playlist":
        return Promise.resolve([{ media: { kind: "hls", playlist: "<html>nope</html>", baseUrl: "https://x.example.test/" } }]);
      case "empty":
        return Promise.resolve([]);
      case "log":
        ctx.log("warn", `resolving ${SECRET_URL}`, { url: SECRET_URL, headers: { Cookie: "c=SuperSecretCookie" }, ref: req.ref, note: SECRET_URL });
        return Promise.resolve([{ media: { kind: "hls", url: ref.url } }]);
      case "results":
        return Promise.resolve(ref.results);
      default:
        return Promise.reject(new TypeError("unknown behavior"));
    }
  };
  return { id: "test", resolve };
}

/** @param {AdapterContext} ctx */
export async function createAdapters(ctx) {
  return [...example.createAdapters(ctx), testAdapter(ctx)];
}
