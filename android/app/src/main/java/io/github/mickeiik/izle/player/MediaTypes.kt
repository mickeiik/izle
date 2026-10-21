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

/**
 * The MIME type for a resolve answer's `media.kind`: `hls`, `dash`, `ts` (progressive MPEG-TS, a channel's endless
 * stream), anything else is played as MP4.
 */
internal fun mediaMimeType(kind: String): String = when (kind) {
    "hls" -> MimeTypes.APPLICATION_M3U8
    "dash" -> MimeTypes.APPLICATION_MPD
    "ts" -> MimeTypes.VIDEO_MP2T
    else -> MimeTypes.VIDEO_MP4
}

/**
 * A channel's progressive stream (`ts`) is never retried by the player itself: a retry continues with a `Range`
 * request at the byte it stopped at, which an endless stream cannot serve (it answers from "now", and the player would
 * skip that many bytes of it). The error goes to the app instead, which resolves the channel again at its live edge.
 */
internal fun restartsInsteadOfResuming(mediaKind: String, live: Boolean): Boolean = live && mediaKind == "ts"

/** The MIME type for a subtitle track's `format`: `srt`, `ttml`, anything else is read as WebVTT. */
internal fun subtitleMimeType(format: String): String = when (format) {
    "srt" -> MimeTypes.APPLICATION_SUBRIP
    "ttml" -> MimeTypes.APPLICATION_TTML
    else -> MimeTypes.TEXT_VTT
}

/** The upstream HTTP status behind a player error (an HTTP answer somewhere in its cause chain), or null. */
@OptIn(UnstableApi::class)
internal fun PlaybackException.httpStatus(): Int? {
    var cause: Throwable? = this
    while (cause != null) {
        if (cause is HttpDataSource.InvalidResponseCodeException) return cause.responseCode
        cause = cause.cause
    }
    return null
}
