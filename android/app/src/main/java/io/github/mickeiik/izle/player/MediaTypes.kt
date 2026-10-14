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

/** The MIME type for a resolve answer's `media.kind`: `hls`, `dash`, anything else is played as MP4. */
internal fun mediaMimeType(kind: String): String = when (kind) {
    "hls" -> MimeTypes.APPLICATION_M3U8
    "dash" -> MimeTypes.APPLICATION_MPD
    else -> MimeTypes.VIDEO_MP4
}

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
