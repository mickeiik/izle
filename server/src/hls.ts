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

export interface PlaylistSummary {
  master: boolean;
  variants: number;
  renditions: number;
  segments: number;
  endList: boolean;
}

export function summarizePlaylist(text: string): PlaylistSummary {
  const s: PlaylistSummary = { master: false, variants: 0, renditions: 0, segments: 0, endList: false };
  let nextIsPlaylist = false;
  for (const line of text.split(LINE_BREAK).map((l) => l.trim())) {
    const tag = line.startsWith("#") ? tagName(line) : null;
    if (tag === "#EXT-X-STREAM-INF") s.master = nextIsPlaylist = true;
    else if (tag === "#EXT-X-MEDIA") {
      s.master = true;
      s.renditions++;
    } else if (tag === "#EXT-X-ENDLIST") s.endList = true;
    else if (tag === null && line !== "") {
      if (nextIsPlaylist) s.variants++;
      else s.segments++;
      nextIsPlaylist = false;
    }
  }
  return s;
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
