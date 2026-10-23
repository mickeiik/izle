# Catalog bundle v1

Status: **stable** (format version 1). Normative; the key words MUST, MUST NOT, SHOULD and MAY are used as in RFC
2119. The machine-readable form is the JSON Schema in [`contract/schema/`](../../contract/schema/) (`common.v1`,
`bundle.v1`, `items.v1`); the TypeScript types are in [`contract/src/bundle.ts`](../../contract/src/bundle.ts).

A catalog bundle is how an owner hands their catalog to izle-server: a directory, read from a local path only (the
server never downloads one), holding **data only**, no code and no credentials. Turning a catalog reference into a
playable stream at play time (signed URLs, cookies, scraping) belongs in a [resolver module](resolver-module-v1.md).

```
<bundle>/
├── bundle.json        manifest
├── items.json         all items
└── assets/            posters and backdrops, content-addressed: <sha256-of-content>.<jpg|png|webp>
```

## bundle.json

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `format` | `"izle-bundle"` | yes | Format marker. |
| `formatVersion` | `1` | yes | Format version. Consumers MUST reject versions they do not know. |
| `catalogId` | Id | yes | Stable identifier of the catalog. It scopes every item and episode id. |
| `buildId` | string | yes | Identifier of this build (no whitespace, ≤ 200 chars), shown in diagnostics. |
| `builtAt` | date-time | yes | ISO 8601 date-time with explicit offset (`Z` or `±hh:mm`). |
| `name` | string | yes | Human-readable catalog name. |
| `generator` | `{name, version}` | no | Tool that produced the bundle. |
| `defaults` | `{uiLanguage?: "tr"\|"en", preferredAudioLanguage?: LanguageTag}` | no | Hints for new devices. Per-device settings on the server always win. |
| `adapters` | Id[] | yes | Every adapter id referenced by an `adapter` source. The server checks that its resolver module provides them. May be empty. |
| `items` | `"items.json"` | yes | Fixed. |
| `assetsDir` | `"assets"` | yes | Fixed. |

## items.json

`{"items": CatalogItem[]}`. The array order has no meaning (the owner arranges the home screen per device).

### CatalogItem

`kind` decides the shape; fields that do not belong to an item's kind are errors. Common fields:

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | Unique within the bundle; durable across builds. |
| `kind` | `"movie"` \| `"series"` \| `"live"` | yes | What the title is, never how many episodes it has ([Rules](#rules) 5): a movie has exactly one episode, a series one or more, a live channel none. |
| `title` | string | yes | Display title. |
| `originalTitle` | string \| null | no | |
| `synopsis` | string \| null | no | |
| `genres` | string[] | no | Free-form, unique. |
| `poster` | string \| null | yes | `assets/<sha256>.<jpg\|png\|webp>`, or null. |
| `backdrop` | string \| null | no | Landscape image behind the TV's open home card: `assets/<sha256>.<jpg\|png\|webp>`, or null (the default when absent). |

Movie and series fields (`kind` is `"movie"` or `"series"`):

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `year` | integer \| null | no | First release year. |
| `rating` | number 0–10 \| null | no | |
| `autoAdvance` | boolean | no | Item default for auto-starting the next episode (default `true`). |
| `episodes` | Episode[] (≥ 1) | yes | **Array order is the approved play order.** |

### Live item

A `live` item is a TV channel: a stream with no beginning and no end, addressed by its item id, always played at its
live edge, with no duration, resume position, progress, play order or auto-advance (the server's history records
when and how long it was watched, never "seen"). `year`, `rating`, `autoAdvance` and `episodes` MUST NOT be given. Its
sources SHOULD be live streams: HLS playlists without `#EXT-X-ENDLIST`, dynamic DASH manifests (`type="dynamic"`) or
`ts` streams.

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `playbackAllowed` | boolean | yes | Explicit approval. `false` = never on a home screen, never resolved. |
| `sources` | Source[] | yes | In preference order; ids unique within the channel. MAY be empty only when `playbackAllowed` is `false`. |

### Episode

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | **Unique within the whole bundle** (the TV API addresses episodes by id alone), durable across builds. An episode id MAY equal an item id. |
| `season`, `number` | integer ≥ 0 \| null | no | Display only; ordering comes from the array. |
| `title` | string \| null | no | |
| `label` | string \| null | no | Display override for the episode badge (e.g. "Special"). |
| `durationMs` | integer \| null | no | Approximate duration, used before playback reports one. |
| `playbackAllowed` | boolean | yes | Explicit approval. `false` = never auto-selected, never resolved, greyed out in the TV's hidden menu. |
| `autoAdvance` | boolean | no | `false` = do not auto-start the next episode after this one (season end, approval boundary). Overrides the item default. |
| `sources` | Source[] | yes | In preference order. MAY be empty only when `playbackAllowed` is `false`. |

### Source

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | Unique within the episode, or within the channel; durable. |
| `type` | `"direct"` \| `"adapter"` | yes | Discriminator. |
| `label` | string | no | Shown in the owner's diagnostics and the TV's hidden menu. |
| `languages` | LanguageFacts | yes | What the stream is known to contain. |
| `subtitleTracks` | SubtitleTrack[] | no | External subtitle files (in addition to any in-stream tracks). |

`type: "direct"` adds `media: {kind: "hls"|"dash"|"mp4"|"ts", url, headers?}`: `url` is http(s); `mp4` means any
progressive file the player can sniff (MP4, QuickTime); `ts` means progressive MPEG-TS over HTTP (for a channel, an
endless response), allowed on any item and meant for channels; `headers` are upstream request headers (e.g.
`Referer`): media with headers is only ever played through the server proxy, so they never reach the TV.

`type: "adapter"` adds `adapter` (an id listed in the manifest's `adapters`) and `ref` (an object, opaque JSON
for the adapter). The server passes `ref` to the adapter at play time and never logs it.

### LanguageFacts and shared types

- **LanguageFacts** — `{audio: LanguageTag[] | null, subtitles: LanguageTag[] | null}`, both keys required: the
  BCP 47 tags of the tracks the stream carries (in-stream or via `subtitleTracks`); `null` = **unknown** (exporters
  MUST use `null` rather than guess); `[]` = known to have none (for `audio`, "no spoken dialogue", which the server
  treats as matching every preferred language).
- **SubtitleTrack** — `{url, language: LanguageTag, format: "vtt"|"srt"|"ttml", label?}`.
- **Id** — `^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$`: URL-path safe, case-sensitive, ≤ 120 characters.
- **LanguageTag** — simplified BCP 47, `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$` (e.g. `en`, `tr`, `pt-BR`, `und`).

## Rules

1. **Strict schema.** Unknown properties are errors, except properties whose name starts with `x-`, which are
   allowed on every object for private annotations and are ignored by izle.
2. **Durable identities.** `catalogId`, item, episode and source ids MUST NOT change between builds of the same
   catalog and MUST NOT be positional (no array indexes, no build-order counters): the server stores progress, home
   screens, cursors and viewing history by id. Exporters whose source keys are not valid ids (keys containing `|`,
   `:` or spaces) MUST map them deterministically (e.g. slug + short hash of the original key) and SHOULD keep an
   identity registry so renames in the source do not change ids.
3. **Explicit play order and approval.** izle never infers either from season/number fields.
4. **Content-addressed images.** A poster or backdrop file's name is the lowercase hex SHA-256 of its bytes and its
   extension matches its content type. Posters SHOULD be 2:3, around 400×600, backdrops 16:9, around 1280×720, both
   well under 1 MiB; without a backdrop the TV's open card lies over the poster, blurred.
5. **Movies have exactly one episode.** A series with only its first episode released is a `series` with one
   episode, and stays one as episodes are added. Exporters MUST NOT derive `kind` from the episode count (izle shows
   a `movie` as a film, and rejects one that gains a second episode).
6. **No secrets.** Bundles SHOULD NOT contain credentials or signed, expiring URLs; resolve those at play time with
   an adapter.
7. **Channels have no episodes.** Exporters MUST NOT model a channel as a one-episode series, nor a film as a channel.

## Validation

The validator checks the JSON Schema and the semantic rules: unique item and episode ids (bundle-wide) and source
ids (per episode or channel), one episode per movie, `playbackAllowed: false` when `sources` is empty, adapter ids
declared in the manifest, poster and backdrop files present with matching SHA-256 and image type, a valid calendar
date in `builtAt`, parseable http(s) URLs. Warnings (non-fatal): unused declared adapters, movies and series without
any playable episode, channels with `playbackAllowed: false`, unreferenced or oversized assets. Programmatic use:
`validateBundle(dir)` returns `{ok, issues, bundle?, stats?}`; `loadBundle(dir)` returns `{bundle, warnings, stats}`
or throws `BundleValidationError`.

### Running the validator

Two commands, equivalent (the same arguments, report and exit status; the usage text names `izle-validate` in both):

- `izle-validate <bundleDir> [--probe] [--json]`, the bin of the contract package (`npx izle-validate` in a checkout);
- `izle-server validate-catalog <bundleDir> [--probe] [--json]`, the installed server; in an unpacked release tarball
  `izle-server-X.Y.Z.tgz`, `node package/bin/izle-server.js validate-catalog …`, with nothing to install.

They take no other option (`-h`/`--help` prints the usage; `--config` or anything else is a usage error). `--probe`
also range-GETs every direct media and subtitle URL (`Range: bytes=0-0`, redirects followed; adapter sources are
skipped) and counts anything other than 200/206 as unreachable. Exit status 0 = valid, 1 = invalid or unreachable,
2 = usage error (the usage on stderr, no report). Producers SHOULD validate with the izle release their server runs
(that release's tarball, or the installed server's `validate-catalog`), not a development checkout.

### JSON report

`--json` prints one JSON object on stdout (without it the output is for people and is not an interface):

```ts
{ ok: boolean, issues: Issue[], stats: BundleStats | null, probes?: Probe[] }
Issue = { severity: "error" | "warning", file: string, path: string, message: string }
BundleStats = { items, movies, series, live, episodes, playableEpisodes, sources, posters, backdrops: number }
Probe = { itemId: string, episodeId: string | null, sourceId: string, what: "media" | "subtitle", host: string,
          ok: boolean, status: number | null, error: string | null, ms: number }
```

| Field | Meaning |
| --- | --- |
| `ok` | No issue of severity `error` and, with `--probe`, every probe `ok`: exit status 0. Warnings do not count. |
| `issues` | In the order found; every field is always present. `file` is relative to the bundle directory (`.` for the directory itself); `path` is a JSON pointer into `file`, `""` for the file as a whole (missing, not JSON, an asset's content), `"/"` for a schema error on its top-level object. `message` is English text for people, not a code to match on. |
| `stats` | Counts as in `validateBundle` (`items` = movies + series + live channels); `null` when `bundle.json` or `items.json` is missing, not JSON or fails the schema, present otherwise (also with other errors). |
| `probes` | Only with `--probe` and when there is no error. One per direct media or subtitle URL; `episodeId` is `null` for a channel's own sources; `host` is the URL's host only (no URL, no headers); `status` is the HTTP status, `null` without a response; `error` is the error's class name (`TypeError`, `TimeoutError`, …), `null` with a response; `ms` is the request's duration. |

Within v1 the report only gains fields: none is removed or changes meaning. Consumers MUST ignore unknown keys.

## Versioning

Within format version 1 only **additive, optional** changes are allowed: new optional properties with a documented
default, recorded in the changelog below. Consumers built for an earlier 1.x text MUST keep working (they reject
unknown non-`x-` properties, so producers SHOULD NOT emit new optional properties until consumers support them).
Anything else (a new required property, a changed meaning, a removed value) requires `formatVersion: 2`. Up to and
including izle 0.6.0, the first deployment, v1 changed in place, marked **breaking (pre-release)** in the changelog;
since then it does not.

## Changelog

- **v1 (2026-10-10)** — initial version.
- **v1, before the first deployment (2026-10-19 to 2026-10-21)** — `CatalogItem.backdrop` and `BundleStats.backdrops`
  (additive); live items (`kind: "live"`), [Rules](#rules) 7, source ids unique per episode or channel,
  `BundleStats.live` and media kind `ts` (breaking (pre-release), changed in place).
- **v1 (2026-10-23)** — the validator's two commands and its `--json` report are documented as a stable interface
  ([Running the validator](#running-the-validator), [JSON report](#json-report)) (additive).
- **v1 (izle 0.6.0, 2026-10-23)** — the first deployment; from here on v1 changes only additively.
