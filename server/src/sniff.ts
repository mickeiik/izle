// What a body is, by its first bytes. The media proxy and the admin checks judge bodies with the same rules, so a
// check passes what the TV gets and fails what it does not.

import { tsSyncOffset } from "./hls.ts";

export type Container = "ts" | "mp4" | "fmp4" | "aac" | "id3" | "webvtt" | "srt" | "ttml" | "mpd" | "m3u8";

/** The containers that are text: never media, even where media was expected. */
const TEXT_CONTAINERS = new Set<Container>(["webvtt", "srt", "ttml", "mpd", "m3u8"]);

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Text, not media: no control characters but whitespace and valid UTF-8 (an HTML error page, JSON, plain text). */
export function looksLikeText(head: Uint8Array): boolean {
  const sample = head.subarray(0, 512);
  if (sample.some((b) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b) || b === 0x7f)) return false;
  try {
    decoder.decode(sample.subarray(0, Math.max(0, sample.length - 3)));
    return true;
  } catch {
    return false;
  }
}

const boxType = (head: Uint8Array): string => (head.length >= 8 ? Buffer.from(head.subarray(4, 8)).toString("latin1") : "");

/**
 * What the first bytes of a body are, by their signature; null when none is recognized. Reads at most the first
 * TS_ALIGN_LOOKAHEAD bytes (MPEG-TS behind up to 4 KiB of junk).
 */
export function sniffContainer(head: Uint8Array): Container | null {
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "id3";
  // At least one whole packet: a short text answer may well start with a "G" (a lone packet must not read as text).
  if (head.length >= 188 && head[0] === 0x47 && (head.length >= 376 ? head[188] === 0x47 : !looksLikeText(head))) return "ts";
  if (tsSyncOffset(head) > 0) return "ts";
  const box = boxType(head);
  if (["ftyp", "moov", "free", "skip", "wide", "mdat"].includes(box)) return "mp4";
  if (["styp", "moof", "sidx", "emsg", "prft"].includes(box)) return "fmp4";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return "aac";
  if (!looksLikeText(head)) return null;
  const text = Buffer.from(head.subarray(0, 4096)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (text.startsWith("WEBVTT")) return "webvtt";
  if (text.startsWith("#EXTM3U")) return "m3u8";
  if (/^\d+\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text)) return "srt";
  const xml = text.replace(/^<\?xml[^>]*>\s*/, "").replace(/^(<!--[\s\S]*?-->\s*)+/, "");
  if (/^<MPD[\s>]/.test(xml)) return "mpd";
  if (/^<(\w+:)?tt[\s>]/.test(xml)) return "ttml";
  return null;
}

/**
 * Media, not text: a media signature, or binary data of no known container (encrypted segments have none). Empty
 * bodies, text formats and anything that reads as text (an error page that answered 200) are not.
 */
export function isMedia(head: Uint8Array, container: Container | null = sniffContainer(head)): boolean {
  if (head.length === 0) return false;
  return container ? !TEXT_CONTAINERS.has(container) : !looksLikeText(head);
}
