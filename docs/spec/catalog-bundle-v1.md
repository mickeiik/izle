# Catalog bundle v1

Status: **stable** (format version 1). Normative. The machine-readable form is the JSON Schema in
[`contract/schema/`](../../contract/schema/) (`common.v1`, `bundle.v1`, `items.v1`); the TypeScript types are in
[`contract/src/bundle.ts`](../../contract/src/bundle.ts). The key words MUST, MUST NOT, SHOULD and MAY are used
as in RFC 2119.

A catalog bundle is how an owner hands their catalog to izle-server: a directory, read from a local path only (the
server never downloads one), holding **data only**, no code and no credentials. Anything needed to turn a catalog
reference into a playable stream at play time (signed URLs, cookies, scraping) belongs in a
[resolver module](resolver-module-v1.md).

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

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | Unique within the bundle; durable across builds. |
| `kind` | `"movie"` \| `"series"` | yes | What the title is, not how many episodes it has ([Rules](#rules) 5). A movie has exactly one episode; a series has one or more. |
| `title` | string | yes | Display title. |
| `originalTitle` | string \| null | no | |
| `year` | integer \| null | no | First release year. |
| `synopsis` | string \| null | no | |
| `genres` | string[] | no | Free-form, unique. |
| `rating` | number 0–10 \| null | no | |
| `poster` | string \| null | yes | `assets/<sha256>.<jpg\|png\|webp>`, or null. |
| `backdrop` | string \| null | no | Landscape image for the TV's home cards: `assets/<sha256>.<jpg\|png\|webp>`, or null (the default when absent). |
| `autoAdvance` | boolean | no | Item default for auto-starting the next episode (default `true`). |
| `episodes` | Episode[] (≥ 1) | yes | **Array order is the approved play order.** |

### Episode

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | **Unique within the whole bundle** (not only within the item), durable across builds. |
| `season`, `number` | integer ≥ 0 \| null | no | Display only; ordering comes from the array. |
| `title` | string \| null | no | |
| `label` | string \| null | no | Display override for the episode badge (e.g. "Special"). |
| `durationMs` | integer \| null | no | Approximate duration, used before playback reports one. |
| `playbackAllowed` | boolean | yes | Explicit approval. `false` = never auto-selected, never resolved, greyed out in the TV's hidden menu. |
| `autoAdvance` | boolean | no | `false` = do not auto-start the next episode after this one (season end, approval boundary). Overrides the item default. |
| `sources` | Source[] | yes | In preference order. MAY be empty only when `playbackAllowed` is `false`. |

### Source

Common fields:

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `id` | Id | yes | Unique within the episode; durable. |
| `type` | `"direct"` \| `"adapter"` | yes | Discriminator. |
| `label` | string | no | Shown in the owner's diagnostics and the TV's hidden menu. |
| `languages` | LanguageFacts | yes | What the stream is known to contain. |
| `subtitleTracks` | SubtitleTrack[] | no | External subtitle files (in addition to any in-stream tracks). |

`type: "direct"` adds `media: {kind: "hls"|"dash"|"mp4", url, headers?}`: `url` is http(s); `mp4` means any
progressive file the player can sniff (MP4, QuickTime); `headers` are upstream request headers (e.g. `Referer`), and
media with headers is only ever played through the server proxy, so they never reach the TV.

`type: "adapter"` adds `adapter` (an id listed in the manifest's `adapters`) and `ref` (an object, opaque JSON
for the adapter). The server passes `ref` to the adapter at play time and never logs it.

### LanguageFacts

`{audio: LanguageTag[] | null, subtitles: LanguageTag[] | null}`, both keys required: the BCP 47 tags of the tracks
the stream carries (in-stream or via `subtitleTracks`); `null` = **unknown** (exporters MUST use `null` rather than
guess); `[]` = known to have none (for `audio`, "no spoken dialogue", e.g. a dialogue-free animation, which the
server treats as matching every preferred language).

### SubtitleTrack and shared types

- **SubtitleTrack** — `{url, language: LanguageTag, format: "vtt"|"srt"|"ttml", label?}`.
- **Id** — `^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$`: URL-path safe, case-sensitive, ≤ 120 characters.
- **LanguageTag** — simplified BCP 47, `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$` (e.g. `en`, `tr`, `pt-BR`, `und`).

## Rules

1. **Strict schema.** Unknown properties are errors, except properties whose name starts with `x-`, which are
   allowed on every object for private annotations and are ignored by izle.
2. **Durable identities.** `catalogId`, item, episode and source ids MUST NOT change between builds of the same
   catalog and MUST NOT be positional (no array indexes, no build-order counters). The server stores progress,
   home screens and cursors by id; a changed id loses them. Exporters whose source keys are not valid ids (for
   example keys containing `|`, `:` or spaces) MUST map them deterministically (e.g. slug + short hash of the
   original key) and SHOULD keep an identity registry so renames in the source do not change ids.
3. **Explicit play order and approval.** The episode array order is the order izle plays in, and
   `playbackAllowed` is required on every episode. izle never infers either from season/number fields.
4. **Content-addressed images.** A poster or backdrop file's name is the lowercase hex SHA-256 of its bytes and
   its extension matches its content type. Posters SHOULD be 2:3, around 400×600, and well under 1 MiB.
   Backdrops SHOULD be 16:9, around 1280×720, well under 1 MiB; without one the TV crops the poster
   to a landscape band.
5. **Movies have exactly one episode.** `kind` says what the title is, never how many episodes it has: a series
   with only its first episode released is a `series` with one episode, and stays one as episodes are added.
   Exporters MUST NOT derive `kind` from the episode count (izle shows a `movie` as a film, and rejects one that
   gains a second episode).
6. **Episode ids are unique across the bundle** (the TV API addresses episodes by id alone).
7. **No secrets.** Bundles SHOULD NOT contain credentials or signed, expiring URLs; resolve those at play time
   with an adapter.

## Validation

`npx izle-validate <bundleDir>` (package `@izle/contract`) checks the JSON Schema and the semantic rules:
unique item and episode ids (bundle-wide) and source ids (per episode), one episode per movie, `playbackAllowed:
false` when `sources` is empty, adapter ids declared in the manifest, poster and backdrop files present with
matching SHA-256 and image type, valid calendar date in `builtAt`, parseable http(s) URLs. Warnings (non-fatal):
unused declared adapters, items without any playable episode, unreferenced or oversized assets. `--probe` additionally
range-GETs every direct media and subtitle URL (`Range: bytes=0-0`, redirects followed) and reports anything
other than 200/206; `--json` prints a machine-readable report. Exit status 0 = valid, 1 = invalid or
unreachable, 2 = usage error. Programmatic use: `validateBundle(dir)` returns `{ok, issues, bundle?, stats?}`;
`loadBundle(dir)` returns `{bundle, warnings, stats}` or throws `BundleValidationError`; `stats` counts items,
movies, series, episodes, playable episodes, sources, posters and backdrops.

## Versioning

Within format version 1 only **additive, optional** changes are allowed: new optional properties with a
documented default, recorded in the changelog below. Consumers built for an earlier 1.x text MUST keep working
(they reject unknown non-`x-` properties, so producers SHOULD NOT emit new optional properties until the consumer
side supports them). Anything else (a new required property, a changed meaning, a removed value) requires
`formatVersion: 2`.

## Changelog

- **v1 (2026-10-10)** — initial version.
- **v1, backdrop (2026-10-19)** — additive: `CatalogItem.backdrop` (optional, default null), a 16:9 landscape image
  under `assets/`, content-addressed and validated like `poster`; `BundleStats.backdrops`. Servers before this
  change reject a bundle that has the property.
