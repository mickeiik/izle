package io.github.mickeiik.izle.player

import androidx.annotation.OptIn
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource

/** The player's preference for the owner's language [tag]: the tag, then its primary subtag (`pt-BR`, `pt`); none without one. */
internal fun languagePreference(tag: String?): Array<String> {
    if (tag.isNullOrBlank()) return emptyArray()
    return listOf(tag, tag.substringBefore('-').lowercase()).distinct().toTypedArray()
}

/** `media.kind`: `hls`, `dash`, `ts` (progressive MPEG-TS, a channel's endless stream), anything else is MP4. */
internal fun mediaMimeType(kind: String): String = when (kind) {
    "hls" -> MimeTypes.APPLICATION_M3U8
    "dash" -> MimeTypes.APPLICATION_MPD
    "ts" -> MimeTypes.VIDEO_MP2T
    else -> MimeTypes.VIDEO_MP4
}

/**
 * A channel's `ts` stream is never retried by the player itself: its `Range` retry would skip that many bytes of an
 * endless stream that answers from "now". The app resolves the channel again at its live edge instead.
 */
internal fun restartsInsteadOfResuming(mediaKind: String, live: Boolean): Boolean = live && mediaKind == "ts"

/** A subtitle track's `format`: `srt`, `ttml`, anything else is WebVTT. */
internal fun subtitleMimeType(format: String): String = when (format) {
    "srt" -> MimeTypes.APPLICATION_SUBRIP
    "ttml" -> MimeTypes.APPLICATION_TTML
    else -> MimeTypes.TEXT_VTT
}

/** The upstream HTTP status somewhere in a player error's cause chain, or null. */
@OptIn(UnstableApi::class)
internal fun PlaybackException.httpStatus(): Int? = generateSequence<Throwable>(this) { it.cause }
    .filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
