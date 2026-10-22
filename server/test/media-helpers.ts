// Catalog items and listening upstreams for the proxy, egress and diagnostics tests.
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import path from "node:path";
import { fixtureManifest, listen, tempDir, writeBundle, type Json } from "./helpers.ts";

export const adapterSource = (adapter: string, id: string, ref: Json, languages: Json = { audio: null, subtitles: null }) =>
  ({ id, type: "adapter", adapter, ref, languages });
export const direct = (id: string, media: Json) => ({ id, type: "direct", languages: { audio: ["en"], subtitles: [] }, media });
export const movie = (id: string, sources: Json[]) =>
  ({ id, kind: "movie", title: id, poster: null, episodes: [{ id: `${id}.main`, playbackAllowed: true, sources }] });
export const channel = (id: string, sources: Json[]) => ({ id, kind: "live", title: id, poster: null, playbackAllowed: true, sources });

/** A bundle of `items` in a fresh temp directory. */
export const bundleOf = async (items: Json[], adapters: string[] = []) =>
  writeBundle(path.join(await tempDir(), "bundle"), { ...fixtureManifest(), adapters }, { items });

/** A loopback upstream, closed after the test, that records the path and headers of every request. */
export async function upstream(t: { after(fn: () => unknown): void }, handler: RequestListener) {
  const hits: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  const l = await listen(server);
  t.after(l.close);
  return { url: l.url, hits };
}

/** The status and the named headers of a response. */
export const heads = (res: Response, ...names: string[]) => [res.status, ...names.map((n) => res.headers.get(n))];
