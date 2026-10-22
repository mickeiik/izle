# Resolver module API v1

Status: **stable** (API version 1), implemented by izle-server. Normative. Types:
[`contract/src/resolver.ts`](../../contract/src/resolver.ts); result schema:
[`contract/schema/resolve-result.v1.schema.json`](../../contract/schema/resolve-result.v1.schema.json). A complete,
runnable example (module, a local stand-in upstream and a catalog) is in
[`server/examples/resolver-example/`](../../server/examples/resolver-example/README.md).

A resolver module is a small ES module, written and trusted by the owner, that turns the opaque `ref` of an
`adapter` source in a [catalog bundle](catalog-bundle-v1.md) (an episode's source, or a
[live channel](catalog-bundle-v1.md#live-item)'s) into a playable stream at play time, for streams that cannot be
written into a bundle: signed and expiring URLs, playlists that need a `Referer`, upstreams that return playlist
text instead of a URL.

## Loading

The server configuration names the module by a **local path** (`resolver.module`) plus a free-form
`resolver.config` object; the server never downloads or installs modules. At startup it:

1. imports the module with `await import(pathToFileURL(absolutePath).href)`;
2. takes the default export if present, otherwise the module namespace, and requires `apiVersion === 1`;
3. calls `createAdapters(ctx)` **once** (within 30 s) and rejects anything but an array of adapters with valid,
   unique ids (catalog id syntax) and a `resolve` function;
4. checks that every id in the bundle manifest's `adapters` is provided, and refuses to start otherwise. A catalog
   reload that names an adapter the module does not provide is refused the same way (the previous catalog stays).

Once loaded, the module's SHA-256 is logged (the first 16 hex digits; the admin API and `check-resolver` show all
of it).

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
| `log(level, msg, fields?)` | The server's logger. Output passes through the same redaction as the server's own logs, which is a heuristic: a field whose name contains one of the words `url`, `uri`, `href`, `header`, `authorization`, `cookie`, `token`, `ref`, `config`, `playlist`, `password`, `secret` or `body` is dropped; in every other string, URLs (`scheme://…` or `//host…`) become `<url host>`, text starting with `#EXTM3U` becomes `<playlist>` and runs of 20 or more base64url characters become `<token>`; an `Error` keeps only its class name and a short `code`. Everything else is written as given, for example a header map or `req.ref` passed as `fields` itself, a short API key, a host without a scheme. |

## Adapter

```ts
export interface Adapter {
  id: string;
  resolve(req: ResolveRequest): Promise<ResolveResult[]>;
  healthcheck?(signal: AbortSignal): Promise<void>;
}
export interface ResolveRequest {
  catalogId: string; itemId: string; sourceId: string;
  episodeId: string | null;              // null: an item-level source (a live channel)
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
moved behind the episode's (or the channel's) other sources for 10 minutes, like a source the TV reported as
failing.

An adapter may be asked for the **same episode a second time while the TV is playing it** (the owner's phone
resolves another source, or the same one, for "Listen along"), so results must be reproducible and side effects
idempotent; a site that counts plays or rate-limits per title is the owner's concern.

A **channel** is not offered for "Listen along", but the TV that plays it resolves the same source again whenever
it renews the stream: shortly before `expiresAt`, when the proxy session ends (a session lives at most 12 h) and
after a player error. A channel can stay on for hours, so results must be reproducible there too, and each one must
name the live stream as it is now (the TV restarts at its live edge).

## ResolveResult

```ts
export interface ResolveResult {
  media: { kind: "hls" | "dash" | "mp4" | "ts"; url: string }
       | { kind: "hls"; playlist: string; baseUrl: string };     // inline playlist text, ≤ 2 MiB, VOD only
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
  in v1 (the proxy does not rewrite MPDs): such a result is skipped as `unsupported`; return HLS, MP4 or TS when
  headers are needed.
- **`ts` media** — progressive MPEG-TS over HTTP (for a channel, an endless response). With `headers` it is
  proxied like `mp4` (`/p/<token>/stream.ts`, streamed through, never buffered); without, the URL goes to the TV
  as-is, like any plain URL.
- **Inline `playlist`** — **VOD only**: served by the proxy as given, as the session's playlist for the whole
  session; relative URIs resolve against `baseUrl`. The text must start with `#EXTM3U` and be at most 2 MiB
  (UTF-8). A channel's playlist slides forward, so it must come as a `url` (with `headers` when needed), which the
  proxy fetches anew on every request.
- **`subtitleTracks[].headers`** — that track alone is fetched through the proxy with its own headers.
- **`languages`, `subtitleTracks`, `label`** — replace the bundle source's values for this playback.
- **`expiresAt`** — passed to the TV (resolve response `expiresAt`) as a validity hint; the TV resolves the same
  source again shortly before it. For a channel, new media from that call restarts playback at the live edge.
  Independently, an upstream 401, 403 or 410 during playback marks the proxy session stale; the TV gets 410 and
  re-resolves.

Results are validated against `resolve-result.v1.schema.json`; an invalid result counts as an `error` named
`InvalidResult` (or `NotAPlaylist` / `PlaylistTooLarge` for inline playlists; the schema already refuses a
`playlist` over 2 097 152 characters as `InvalidResult`).

## Execution model

- Each `resolve` runs under `AbortSignal.any([requestSignal, deadline])`, the deadline being an ordinary timer of
  `deadlineMs`: 12 s per source by default (`resolver.deadlineMs`) within a 30 s budget per TV request
  (`resolver.budgetMs`).
  A call that ignores the signal is abandoned when its deadline passes (code `timeout`); sources left when the
  budget is used up are reported as `timeout` with the name `BudgetExhausted`. Synchronous throws are caught.
  `req.ref` is a copy: changing it does not change the catalog.
- Direct bundle sources never reach adapters.
- The module is in-process, owner-trusted code, with no sandbox beyond deadlines and result validation. Modules
  MUST honour `signal`, SHOULD avoid long synchronous work, and MUST log only through `ctx.log`. The redaction is a
  safety net, not a licence: modules MUST NOT pass header maps, `req.ref`, `ctx.config`, playlist text, stream URLs
  or tokens to `ctx.log` in any shape (as `fields`, nested, or in `msg`); log ids, counts, status codes, hosts and
  error names instead.
- Source-specific logic MUST NOT go into izle itself: izle stays generic, the module lives with the owner's catalog,
  out of tree.

## Versioning

Additive, optional changes (new optional context members, new optional result fields) stay within API version
1 and are listed below. Anything else bumps `RESOLVER_API_VERSION`, and the server refuses modules declaring a
version it does not implement.

Until the first deployment the owner may change v1 in place; such changes are marked **breaking (pre-release)** in
the changelog.

## Changelog

- **v1 (2026-10-10)** — initial version.
- **v1, before the first deployment (2026-10-10 to 2026-10-21)** — clarifications with no API change (how results
  are used, the `empty` code, `BudgetExhausted`, Listen along's second call, `ctx.log` as a heuristic), then
  breaking (pre-release), changed in place: `ResolveRequest.episodeId` is null for a live channel, inline playlists
  are VOD only, media kind `ts`.
