// Generic HLS playlist rewriting for the media proxy. Format-level only: nothing here knows about any source.

/** What a rewritten URI points at: another playlist (`p`, rewritten in turn) or a raw resource (`r`, streamed). */
export type LinkKind = "p" | "r";

/** Tags whose `URI="…"` attribute names another playlist; every other tag's URI is a raw resource. */
const PLAYLIST_URI_TAGS = new Set(["#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-RENDITION-REPORT"]);
const URI_ATTRIBUTE = /(^|,|:)(\s*URI\s*=\s*)"([^"]*)"/g;
const LINE_BREAK = /\r?\n|\r/;

const withoutBom = (text: string): string => text.replace(/^﻿/, "");
const tagName = (line: string): string => line.split(":", 1)[0]!.trim().toUpperCase();

/** Bounds on a rewrite, so its work and output stay proportional to the playlist read, whatever its URIs resolve to. */
export interface RewriteLimits {
  maxLines: number;
  maxLength: number;
  maxUrlLength: number;
}

const NO_LIMITS: RewriteLimits = { maxLines: Infinity, maxLength: Infinity, maxUrlLength: Infinity };

/** A playlist over one of the rewrite limits; `message` says which (no URL in it). */
export class PlaylistTooLarge extends Error {}

export function isPlaylistText(text: string): boolean {
  return withoutBom(text).trimStart().startsWith("#EXTM3U");
}

/**
 * Rewrites every URI of an HLS playlist (URI lines and `URI="…"` attributes) resolved against `baseUrl`: http(s)
 * ones become `link(absoluteUrl, kind)`, anything else (`data:`, `skd:`, unparsable) stays. Line endings become `\n`,
 * a BOM goes. Throws PlaylistTooLarge past one of `limits` (a URL too long to rewrite is refused, not kept).
 */
export function rewritePlaylist(text: string, baseUrl: string, link: (url: string, kind: LinkKind) => string, limits: RewriteLimits = NO_LIMITS): string {
  const rewrite = (uri: string, kind: LinkKind): string => {
    const abs = URL.parse(uri.trim(), baseUrl);
    if (!abs || (abs.protocol !== "http:" && abs.protocol !== "https:")) return uri;
    abs.hash = "";
    if (abs.href.length > limits.maxUrlLength) throw new PlaylistTooLarge(`a URI longer than ${limits.maxUrlLength} characters`);
    return link(abs.href, kind);
  };

  let nextIsPlaylist = false;
  let length = 0;
  const input = withoutBom(text).split(LINE_BREAK);
  if (input.length > limits.maxLines) throw new PlaylistTooLarge(`more than ${limits.maxLines} lines`);
  const rewriteLine = (line: string): string => {
    const trimmed = line.trim();
    if (trimmed === "") return line;
    if (trimmed.startsWith("#")) {
      if (!trimmed.startsWith("#EXT")) return line; // a comment
      const tag = tagName(trimmed);
      if (tag === "#EXT-X-STREAM-INF") nextIsPlaylist = true;
      if (!/URI\s*=/i.test(trimmed)) return line;
      const kind: LinkKind = PLAYLIST_URI_TAGS.has(tag) ? "p" : "r";
      return line.replace(URI_ATTRIBUTE, (_m, sep: string, attr: string, value: string) => `${sep}${attr}"${rewrite(value, kind)}"`);
    }
    const kind: LinkKind = nextIsPlaylist ? "p" : "r";
    nextIsPlaylist = false;
    return rewrite(trimmed, kind);
  };
  return input
    .map((line) => {
      const out = rewriteLine(line);
      length += out.length + 1;
      if (length > limits.maxLength) throw new PlaylistTooLarge(`more than ${limits.maxLength} characters rewritten`);
      return out;
    })
    .join("\n");
}

const TS_PACKET = 188;
const TS_ALIGN_WINDOW = 4096;
/** Consecutive sync bytes (one per packet) that identify an MPEG-TS stream. */
const TS_SYNC_PACKETS = 5;
export const TS_ALIGN_LOOKAHEAD = TS_ALIGN_WINDOW + TS_PACKET * TS_SYNC_PACKETS;

/** The smallest o < 4096 with a 0x47 sync byte at o, o+188, …, o+188·4; 0 when aligned already or none exists. */
export function tsSyncOffset(head: Uint8Array): number {
  if (head[0] === 0x47) return 0;
  const last = Math.min(TS_ALIGN_WINDOW, head.length - TS_PACKET * (TS_SYNC_PACKETS - 1));
  for (let o = 1; o < last; o++) {
    let k = 0;
    while (k < TS_SYNC_PACKETS && head[o + k * TS_PACKET] === 0x47) k++;
    if (k === TS_SYNC_PACKETS) return o;
  }
  return 0;
}

/** The attributes of a tag's attribute list (`KEY=value,KEY="quoted, value"`), names upper-cased, quotes removed. */
export function tagAttributes(line: string): Map<string, string> {
  const list = line.slice(line.indexOf(":") + 1);
  const out = new Map<string, string>();
  for (const m of list.matchAll(/\s*([A-Za-z0-9-]+)\s*=\s*("[^"]*"|[^,]*)\s*(?:,|$)/g)) {
    const value = m[2]!.trim();
    out.set(m[1]!.toUpperCase(), value.startsWith('"') ? value.slice(1, -1) : value);
  }
  return out;
}

/** A variant of a master playlist: its URI, and its CODECS, RESOLUTION and BANDWIDTH as written (null when absent). */
export interface Variant {
  uri: string;
  codecs: string | null;
  resolution: string | null;
  bandwidth: number | null;
}

/** A rendition (`#EXT-X-MEDIA`) with a playlist of its own: AUDIO, SUBTITLES or VIDEO. */
export interface Rendition {
  type: string;
  uri: string;
}

/** The variants (`#EXT-X-STREAM-INF`, I-frame ones left out) and renditions with a URI of a master playlist, in order. */
export function masterPlaylist(text: string): { variants: Variant[]; renditions: Rendition[] } {
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  let pending: Map<string, string> | null = null;
  for (const line of withoutBom(text).split(LINE_BREAK).map((l) => l.trim())) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      const tag = tagName(line);
      if (tag === "#EXT-X-STREAM-INF") pending = tagAttributes(line);
      else if (tag === "#EXT-X-MEDIA") {
        const a = tagAttributes(line);
        const uri = a.get("URI");
        if (uri) renditions.push({ type: (a.get("TYPE") ?? "").toUpperCase(), uri });
      }
      continue;
    }
    if (pending) {
      const bandwidth = Number(pending.get("BANDWIDTH"));
      variants.push({
        uri: line, codecs: pending.get("CODECS") || null, resolution: pending.get("RESOLUTION") || null,
        bandwidth: Number.isSafeInteger(bandwidth) && bandwidth >= 0 ? bandwidth : null,
      });
    }
    pending = null;
  }
  return { variants, renditions };
}

/** A byte range of a resource (`#EXT-X-BYTERANGE`, a map's `BYTERANGE`), as an HTTP `Range` value. */
export type ByteRange = { offset: number; length: number };

export const rangeHeader = (r: ByteRange): string => `bytes=${r.offset}-${r.offset + r.length - 1}`;

/** A segment of a media playlist, with the key and the init section (`#EXT-X-MAP`) in effect for it. */
export interface MediaSegment {
  uri: string;
  range: ByteRange | null;
  /** Null when unencrypted (no key, or `METHOD=NONE`). */
  key: { method: string; uri: string | null } | null;
  map: { uri: string; range: ByteRange | null } | null;
}

function byteRange(value: string | undefined, next: number): ByteRange | null {
  const m = value === undefined ? null : /^\s*(\d{1,15})(?:@(\d{1,15}))?\s*$/.exec(value);
  return m ? { length: Number(m[1]), offset: m[2] === undefined ? next : Number(m[2]) } : null;
}

/** The segments of a media playlist in order, and whether it ends (`#EXT-X-ENDLIST`; a live playlist does not). */
export function mediaPlaylist(text: string): { segments: MediaSegment[]; endList: boolean } {
  const segments: MediaSegment[] = [];
  let endList = false;
  let key: MediaSegment["key"] = null;
  let map: MediaSegment["map"] = null;
  // Where a sub-range without an offset starts: right after the previous sub-range of the same resource.
  const ends = new Map<string, number>();
  let pendingRange: string | undefined;
  for (const line of withoutBom(text).split(LINE_BREAK).map((l) => l.trim())) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      const tag = tagName(line);
      if (tag === "#EXT-X-ENDLIST") endList = true;
      else if (tag === "#EXT-X-BYTERANGE") pendingRange = line.slice(line.indexOf(":") + 1);
      else if (tag === "#EXT-X-KEY") {
        const a = tagAttributes(line);
        const method = (a.get("METHOD") ?? "NONE").toUpperCase();
        key = method === "NONE" ? null : { method, uri: a.get("URI") ?? null };
      } else if (tag === "#EXT-X-MAP") {
        const a = tagAttributes(line);
        const uri = a.get("URI");
        map = uri ? { uri, range: byteRange(a.get("BYTERANGE"), 0) } : null;
      }
      continue;
    }
    const range = pendingRange === undefined ? null : byteRange(pendingRange, ends.get(line) ?? 0);
    if (range) ends.set(line, range.offset + range.length);
    pendingRange = undefined;
    segments.push({ uri: line, range, key, map });
  }
  return { segments, endList };
}
