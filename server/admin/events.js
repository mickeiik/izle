// @ts-check
// The server's event stream (`GET /admin/events/stream`), for the life of a view: the views hear of changes as they
// happen instead of waiting for their next poll (which stays, as the fallback). Read with `fetch`, because a
// browser's `EventSource` cannot send the Authorization header; the token never goes in the URL.

import { getToken } from "./api.js";
import { parseSse } from "./lib.js";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Follows the events matching `filter` until `scope` ends; after a gap (the consumer fell behind, or the stream was
 * away for long) `handler` gets `{ type: "gap" }` first, so a view re-reads what it shows. A lost connection is
 * reopened with backoff after the last event seen; a refused token ends the watch (the next API call signs out).
 * @param {import("./router.js").Scope} scope @param {{ devices?: string[], types?: string[] }} filter
 * @param {(event: any) => void} handler
 */
export function watchEvents(scope, filter, handler) {
  let last = /** @type {string | null} */ (null);
  let backoff = MIN_BACKOFF_MS;
  const url = () => {
    const q = new URLSearchParams();
    if (last !== null) q.set("after", last);
    if (filter.devices?.length) q.set("devices", filter.devices.join(","));
    if (filter.types?.length) q.set("types", filter.types.join(","));
    const s = q.toString();
    return `/api/v1/admin/events/stream${s ? `?${s}` : ""}`;
  };
  const pause = (/** @type {number} */ ms) =>
    new Promise((resolve) => {
      const stop = () => (clearTimeout(t), resolve(undefined));
      const t = setTimeout(() => (scope.signal.removeEventListener("abort", stop), resolve(undefined)), ms);
      scope.signal.addEventListener("abort", stop, { once: true });
    });
  const deliver = (/** @type {{ id: string | null, event: string, data: string }} */ e) => {
    if (e.id !== null) last = e.id;
    if (e.event === "gap") return handler({ type: "gap" });
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return; // not ours
    }
    handler(parsed);
  };
  const read = async () => {
    const res = await fetch(url(), { headers: { Authorization: `Bearer ${getToken() ?? ""}` }, signal: scope.signal });
    if (res.status === 401) return false;
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    backoff = MIN_BACKOFF_MS;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return true;
      const { events, rest } = parseSse(buffer + decoder.decode(value, { stream: true }));
      buffer = rest;
      for (const e of events) deliver(e);
    }
  };
  void (async () => {
    while (scope.alive()) {
      try {
        if (!(await read())) return;
      } catch {
        // the server went away, or the view ended: the loop decides
      }
      if (!scope.alive()) return;
      await pause(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  })();
}
