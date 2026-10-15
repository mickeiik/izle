# Resolver module API v1

Status: **stable** (API version 1), implemented by izle-server. Normative. Types:
[`contract/src/resolver.ts`](../../contract/src/resolver.ts); result schema:
[`contract/schema/resolve-result.v1.schema.json`](../../contract/schema/resolve-result.v1.schema.json). A complete,
runnable example (module, a local stand-in upstream and a catalog) is in
[`server/examples/resolver-example/`](../../server/examples/resolver-example/README.md).

A resolver module is a small ES module, written and trusted by the owner, that turns the opaque `ref` of an
`adapter` source in a [catalog bundle](catalog-bundle-v1.md) into a playable stream at play time, for streams that
cannot be written into a bundle: signed and expiring URLs, playlists that need a `Referer`, upstreams that return
playlist text instead of a URL.

## Loading

The server configuration names the module by a **local path** (`resolver.module`) plus a free-form
`resolver.config` object; the server never downloads or installs modules. At startup it:

1. imports the module with `await import(pathToFileURL(absolutePath).href)` and logs its SHA-256 (the first 16
   hex digits; the admin API and `check-resolver` show all of it);
2. takes the default export if present, otherwise the module namespace, and requires `apiVersion === 1`;
3. calls `createAdapters(ctx)` **once** (within 30 s) and rejects anything but an array of adapters with valid,
   unique ids (catalog id syntax) and a `resolve` function;
4. checks that every id in the bundle manifest's `adapters` is provided, and refuses to start otherwise. A catalog
   reload that names an adapter the module does not provide is refused the same way (the previous catalog stays).

Any failure stops the server with a message naming the module file and the error's class name, never the error's
message. Without a configured module the server still starts; `adapter` sources are then unavailable.
`izle-server check-resolver [--config <file>]` performs the same steps, checks the configured catalog, and runs
every adapter's `healthcheck` (15 s each); it exits with status 1 on any problem.

The module is JavaScript. In development izle-server runs TypeScript through `tsx`, so a `.ts` module may load
there, but deployments should point at plain `.js`.

```ts
export const RESOLVER_API_VERSION = 1;
export interface ResolverModule { apiVersion: 1; createAdapters(ctx: AdapterContext): Adapter[] | Promise<Adapter[]> }
```

## AdapterContext

| Member | Meaning |
|---|---|
| `config` | The `resolver.config` object from the server configuration (paths, keys). Never logged. |
| `dataDir` | A directory owned by the module for caches or state (created by the server). |
| `fetch` | The `fetch` to use. Pass the request's `signal` to it. |
| `log(level, msg, fields?)` | The server's logger. Output passes through the same redaction as the server's own logs (URLs reduced to their host, tokens, headers, refs and config removed). |

## Adapter

```ts
export interface Adapter {
  id: string;
  resolve(req: ResolveRequest): Promise<ResolveResult[]>;
  healthcheck?(signal: AbortSignal): Promise<void>;
}
export interface ResolveRequest {
  catalogId: string; itemId: string; episodeId: string; sourceId: string;
  ref: Record<string, unknown>;          // the source's ref, as written in the bundle
  preferredAudioLanguage: string | null; // the device's setting
  signal: AbortSignal;                   // aborted on deadline or when the TV goes away
  deadlineMs: number;                    // budget for this call
}
```

`resolve` returns candidates in preference order. The server uses the **first result it can serve** (see below) and
ignores the rest; to fall back between distinct streams, list them as separate sources in the bundle, so the TV
can exclude a failing one. An empty array means "nothing playable right now"; throwing (or rejecting) means
failure. The server records only the adapter id, a code (`timeout`, `abort`, `error`, or `empty` for an empty
array) and the error's `name`, **never its message**, which often contains URLs. A source whose adapter failed is
moved behind the episode's other sources for 10 minutes, like a source the TV reported as failing.

An adapter may be asked for the **same episode a second time while the TV is playing it** (the owner's phone
resolves another source, or the same one, for "Listen along"), so results must be reproducible and side effects
idempotent; a site that counts plays or rate-limits per title is the owner's concern.

## ResolveResult

```ts
export interface ResolveResult {
  media: { kind: "hls" | "dash" | "mp4"; url: string }
       | { kind: "hls"; playlist: string; baseUrl: string };     // inline playlist text, ≤ 2 MiB
  headers?: Record<string, string>;                               // upstream request headers
  languages?: LanguageFacts;                                      // overrides the bundle's facts for this result
  subtitleTracks?: Array<SubtitleTrack & { headers?: Record<string, string> }>;
  label?: string;
  expiresAt?: string;                                             // ISO 8601 validity hint
}
```

- **Plain URL, no headers** — sent to the TV as-is (unless the server sets `proxy.always`).
- **`headers` present** — the server creates a proxy session and gives the TV a `/p/<token>/…` URL. Headers
  never leave the server. Playlists are rewritten so every URI (segments, keys, variant and subtitle playlists,
  `URI="…"` attributes) goes through the same session with the same headers. DASH with headers is not supported
  in v1 (the proxy does not rewrite MPDs): such a result is skipped as `unsupported`; return HLS or MP4 when
  headers are needed.
- **Inline `playlist`** — served by the proxy as the session's playlist; relative URIs resolve against
  `baseUrl`. The text must start with `#EXTM3U` and be at most 2 MiB (UTF-8).
- **`subtitleTracks[].headers`** — that track alone is fetched through the proxy with its own headers.
- **`languages`, `subtitleTracks`, `label`** — replace the bundle source's values for this playback.
- **`expiresAt`** — passed to the TV (resolve response `expiresAt`) as a validity hint. Independently, an
  upstream 401, 403 or 410 during playback marks the proxy session stale; the TV gets 410 and re-resolves.

Results are validated against `resolve-result.v1.schema.json`; an invalid result counts as an `error` named
`InvalidResult` (or `NotAPlaylist` / `PlaylistTooLarge` for inline playlists).

## Execution model

- Each `resolve` runs under `AbortSignal.any([requestSignal, deadline])`, the deadline being an ordinary timer of
  `deadlineMs`: 12 s per source by default (`resolver.deadlineMs`) within a 30 s budget per TV request
  (`resolver.budgetMs`).
  A call that ignores the signal is abandoned when its deadline passes (code `timeout`); sources left when the
  budget is used up are reported as `timeout` with the name `BudgetExhausted`. Synchronous throws are caught.
  `req.ref` is a copy: changing it does not change the catalog.
- Direct bundle sources never reach adapters.
- The module is in-process, owner-trusted code, with no sandbox beyond deadlines and result validation. Modules
  MUST honour `signal`, SHOULD avoid long synchronous work, and MUST NOT log URLs, headers or tokens except through
  `ctx.log` (which redacts them).
- Source-specific logic MUST NOT go into izle itself: izle stays generic, the module lives with the owner's catalog,
  out of tree.

## Versioning

Additive, optional changes (new optional context members, new optional result fields) stay within API version
1 and are listed below. Anything else bumps `RESOLVER_API_VERSION`, and the server refuses modules declaring a
version it does not implement.

## Changelog

- **v1 (2026-10-10)** — initial version.
- **v1, server implementation (2026-10-10)** — no API change. Clarified how the server uses results (first
  servable one; subtitle-track headers proxied per track), the `empty` failure code, `BudgetExhausted`, and
  that a catalog reload is refused when it needs an adapter the module does not provide.
- **v1, Listen along (2026-10-11)** — no API change. An adapter may be called a second time for an episode the TV
  is playing (the owner's phone); failures of such calls do not penalize the source for the TV.
