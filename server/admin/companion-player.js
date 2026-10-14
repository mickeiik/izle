// @ts-check
// The audio side of "Listen along": loads a companion stream into an <audio> element, natively (MP4 everywhere,
// HLS where the browser plays it and can pick a language) or through the vendored hls.js, loaded on first use.
// Companion media is always proxied by the server, so the element only ever loads same-origin URLs (CSP
// `media-src 'self' blob:`; hls.js hands the element a page-local object URL).

import { sameLanguage } from "./lib.js";

/** An error the owner sees as it is: its `code` is looked up in lib.js's error texts. */
export class PlayerError extends Error {
  /** @param {"hls_unsupported" | "hls_unavailable"} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The part of hls.js this page uses (vendor/hls.min.js, 1.7.3).
 * @typedef {object} HlsInstance
 * @property {number} autoLevelCapping
 * @property {Array<{ lang?: string }>} audioTracks
 * @property {number} audioTrack
 * @property {(event: string, fn: (event: string, data: any) => void) => void} on
 * @property {(event: string, fn: () => void) => void} once
 * @property {(url: string) => void} loadSource
 * @property {(media: HTMLMediaElement) => void} attachMedia
 * @property {() => void} destroy
 *
 * @typedef {{ new (config: Record<string, unknown>): HlsInstance, isSupported(): boolean, Events: Record<string, string> }} HlsClass
 */

/** @type {Promise<HlsClass> | null} */
let hlsLoading = null;

/** Loads the vendored hls.js once (only browsers without a usable native HLS need it). */
function loadHls() {
  const w = /** @type {Window & { Hls?: HlsClass }} */ (window);
  if (w.Hls) return Promise.resolve(w.Hls);
  hlsLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/hls.min.js";
    script.onload = () => (w.Hls ? resolve(w.Hls) : reject(new PlayerError("hls_unavailable")));
    script.onerror = () => {
      hlsLoading = null; // a later attempt may try again
      reject(new PlayerError("hls_unavailable"));
    };
    document.head.append(script);
  });
  return hlsLoading;
}

/** Browsers that claim native HLS ("maybe") but then fail switch to hls.js for the rest of the page's life. */
let nativeHlsFailed = false;

/** The native player failed on HLS: from now on hls.js plays it. */
export function nativeHlsBroken() {
  nativeHlsFailed = true;
}

/**
 * @typedef {object} Attached
 * @property {"direct" | "native HLS" | "hls.js"} transport
 * @property {() => void} destroy
 */

/**
 * Loads a stream into the audio element: natively (MP4 everywhere, HLS where the browser plays it) or through
 * hls.js.
 * @param {HTMLAudioElement} audio
 * @param {{ kind: string, url: string }} media
 * @param {string | null} language audio language to pick inside the stream
 * @param {(what: string) => void} onFatal
 * @returns {Promise<Attached>}
 */
export async function attach(audio, media, language, onFatal) {
  const url = new URL(media.url, location.href).toString();
  // Native HLS only when the browser claims it and, if a language is wanted, can switch audio tracks (Chromium
  // answers "maybe" but has no audioTracks API, so a chosen language would be ignored there).
  const nativeHls = !nativeHlsFailed && audio.canPlayType("application/vnd.apple.mpegurl") !== "" && (!language || "audioTracks" in audio);
  if (media.kind !== "hls" || nativeHls) {
    const onMeta = () => {
      const tracks = /** @type {any} */ (audio).audioTracks;
      if (!tracks || !language) return;
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = sameLanguage(language, tracks[i].language);
    };
    audio.addEventListener("loadedmetadata", onMeta);
    audio.src = url;
    audio.load();
    return {
      transport: media.kind === "hls" ? "native HLS" : "direct",
      destroy() {
        audio.removeEventListener("loadedmetadata", onMeta);
      },
    };
  }
  const Hls = await loadHls();
  if (!Hls.isSupported()) throw new PlayerError("hls_unsupported");
  // No worker: the page's CSP has no worker-src. Level 0 only: the video is decoded and thrown away.
  const hls = new Hls({ enableWorker: false, startLevel: 0, maxBufferLength: 30, backBufferLength: 10 });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    hls.autoLevelCapping = 0;
  });
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    if (!language) return;
    const i = hls.audioTracks.findIndex((t) => sameLanguage(language, t.lang));
    if (i >= 0) hls.audioTrack = i;
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data?.fatal) onFatal(`${data.type}: ${data.details}`);
  });
  // play() needs the element to have its media source: wait until hls.js has attached it.
  const attached = new Promise((resolve) => hls.once(Hls.Events.MEDIA_ATTACHED, () => resolve(undefined)));
  hls.loadSource(url);
  hls.attachMedia(audio);
  await attached;
  return {
    transport: "hls.js",
    destroy() {
      hls.destroy();
    },
  };
}
