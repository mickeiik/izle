# Resolver module API v1

Status: **stable** (API version 1). Normative. Types: [`contract/src/resolver.ts`](../../contract/src/resolver.ts);
result schema: [`contract/schema/resolve-result.v1.schema.json`](../../contract/schema/resolve-result.v1.schema.json).
The server-side loader and proxy are implemented in Phase 4 of the [roadmap](../roadmap.md).

A resolver module is a small ES module, written and trusted by the owner, that turns the opaque `ref` of an
`adapter` source in a [catalog bundle](catalog-bundle-v1.md) into a playable stream at play time. It exists for
catalogs whose streams cannot be written into a bundle: signed and expiring URLs, playlists that need a
`Referer`, upstreams that return playlist text instead of a URL.

## Loading

The server configuration names the module by a **local path** (`resolver.module`) plus a free-form
`resolver.config` object. The server never downloads or installs modules. At startup it:

1. imports the module with `await import(pathToFileURL(absolutePath).href)` and logs its SHA-256;
2. takes the default export if present, otherwise the module namespace, and requires `apiVersion === 1`;
3. calls `createAdapters(ctx)` **once** and rejects duplicate adapter ids;
4. checks that every id in the bundle manifest's `adapters` is provided, and refuses to start otherwise.

`izle-server check-resolver` performs the same steps and then runs every adapter's `healthcheck`.

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

`resolve` returns candidates in preference order. An empty array means "nothing playable right now". Throwing
(or rejecting) means failure; the server records only the adapter id, a code (`timeout`, `abort`, `error`) and
the error's `name`, **never its message**, because messages often contain URLs.

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
  `URI="…"` attributes) goes through the same session. DASH with headers is not supported in v1: return HLS or
  MP4 when headers are needed.
- **Inline `playlist`** — served by the proxy as the session's playlist; relative URIs resolve against
  `baseUrl`.
- **`expiresAt`** — lets the TV re-resolve before a signed URL expires. Independently, an upstream 401/403
  during playback marks the proxy session stale and the TV re-resolves.

Results are validated against `resolve-result.v1.schema.json`; an invalid result counts as an `error`.

## Execution model

- Each `resolve` runs under `AbortSignal.any([requestSignal, AbortSignal.timeout(deadlineMs)])`; the default
  deadline is 12 s per source within a 30 s budget per TV request. Synchronous throws are caught.
- Direct bundle sources never reach adapters.
- The module is in-process, owner-trusted code. There is no sandbox beyond deadlines and result validation.
  Modules MUST honour `signal`, SHOULD avoid long synchronous work, and MUST NOT log URLs, headers or tokens
  except through `ctx.log` (which redacts them).
- Modules MUST NOT contain source-specific logic in izle itself: izle stays generic, the module lives with the
  owner's catalog, out of tree.

## Versioning

Additive, optional changes (new optional context members, new optional result fields) stay within API version
1 and are listed below. Anything else bumps `RESOLVER_API_VERSION`, and the server refuses modules declaring a
version it does not implement.

## Changelog

- **v1 (2026-10-10)** — initial version.
