// Generic HLS playlist rewriting for the media proxy. Format-level only: nothing here knows about any source.

/** What a rewritten URI points at: another playlist (`p`, rewritten in turn) or a raw resource (`r`, streamed). */
export type LinkKind = "p" | "r";

/** Tags whose `URI="…"` attribute names another playlist; every other tag's URI is a raw resource. */
const PLAYLIST_URI_TAGS = new Set(["#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-RENDITION-REPORT"]);
const URI_ATTRIBUTE = /(^|,|:)(\s*URI\s*=\s*)"([^"]*)"/g;
/** Line endings a playlist may use: `\n`, `\r\n` or a lone `\r`. */
const LINE_BREAK = /\r?\n|\r/;

const withoutBom = (text: string): string => text.replace(/^﻿/, "");
const tagName = (line: string): string => line.split(":", 1)[0]!.trim().toUpperCase();

export function isPlaylistText(text: string): boolean {
  return withoutBom(text).trimStart().startsWith("#EXTM3U");
}

/**
 * Rewrites every URI of an HLS playlist (master or media): URI lines (variants, segments) and `URI="…"` attributes
 * (keys, maps, renditions, i-frame playlists, parts, preload hints). Each URI is resolved against `baseUrl`; http(s)
 * results are replaced by `link(absoluteUrl, kind)`, anything else (`data:`, `skd:`, unparsable) is kept as it is.
 * Line endings are normalized to `\n`; a leading BOM is dropped.
 */
export function rewritePlaylist(text: string, baseUrl: string, link: (url: string, kind: LinkKind) => string): string {
  const rewrite = (uri: string, kind: LinkKind): string => {
    let abs: URL;
    try {
      abs = new URL(uri.trim(), baseUrl);
    } catch {
      return uri;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return uri;
    abs.hash = "";
    return link(abs.href, kind);
  };

  let nextIsPlaylist = false;
  const lines = withoutBom(text).split(LINE_BREAK).map((line) => {
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
  });
  return lines.join("\n");
}

export interface PlaylistSummary {
  master: boolean;
  variants: number;
  renditions: number;
  segments: number;
  endList: boolean;
}

/** Counts what a playlist contains (admin diagnostics). */
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
/** Junk accepted before the first packet. */
const TS_ALIGN_WINDOW = 4096;
/** Consecutive sync bytes (one per packet) that identify an MPEG-TS stream. */
const TS_SYNC_PACKETS = 5;
/** Bytes `tsSyncOffset` needs to decide for any offset in the window. */
export const TS_ALIGN_LOOKAHEAD = TS_ALIGN_WINDOW + TS_PACKET * TS_SYNC_PACKETS;

/**
 * Offset of the first MPEG-TS packet in `head`: the smallest o < 4096 with a 0x47 sync byte at o, o+188, …,
 * o+188·4. 0 when the data already starts aligned or no such offset exists (then nothing is trimmed).
 */
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
