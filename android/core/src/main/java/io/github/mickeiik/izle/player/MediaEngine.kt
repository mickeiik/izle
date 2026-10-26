package io.github.mickeiik.izle.player

import androidx.media3.common.Player

/** What the controller needs to play media; a decoder in the app, a fake in tests. */
interface MediaEngine {
    /** Loads and prepares an episode at [startAtMs], or a channel at its live edge. */
    fun load(media: MediaSpec, startAtMs: Long?)
    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
    fun stop()
    /** Frees the decoder; a later [load] may create it again. */
    fun release()
    var playWhenReady: Boolean
    /** Playback speed, nominally 1f; the companion app's sync nudges it to catch up with or hold back for the TV. */
    var playbackRate: Float
    val isPlaying: Boolean
    val positionMs: Long
    /** Null when unknown; for a channel, the live window (the controller shows none). */
    val durationMs: Long?
    val buffering: Boolean
    fun applyPreferences(preferredAudioLanguage: String?, subtitlesLanguage: String?)
    fun audioTracks(): List<TrackOption>
    fun textTracks(): List<TrackOption>
    fun selectAudio(option: TrackOption?)
    fun selectText(option: TrackOption?)
    fun setListener(listener: Listener?)
    /** What the screen renders; null for an engine without a picture. */
    val surface: Player?

    /** Events arrive in order on the main thread, with engine properties already updated. */
    interface Listener {
        fun onReady()
        fun onEnded()
        fun onError(error: MediaError)
        fun onIsPlayingChanged(isPlaying: Boolean)

        /** After every state or `playWhenReady` change (after [onReady] or [onEnded] for those). */
        fun onStateChanged()
        fun onCues(text: String?)
    }
}

data class MediaSpec(
    val url: String, val kind: String, val subtitles: List<SubtitleSpec>, val mediaId: String, val live: Boolean,
    /**
     * Sent with every request of the stream (playlist, keys, segments): a found link's `Referer`, `Origin` and
     * `Cookie` in the companion app. Empty for everything the TV plays.
     */
    val headers: Map<String, String> = emptyMap(),
) {
    /** The URL and the header values are the owner's; they never reach a log or a message. */
    override fun toString(): String =
        "MediaSpec(kind=$kind, mediaId=$mediaId, live=$live, subtitles=${subtitles.size}, headers=${headers.keys})"
}

data class SubtitleSpec(val url: String, val language: String, val format: String, val label: String?)

/** [cause] is for diagnostics, which use class names and never its message. */
data class MediaError(val codeName: String, val httpStatus: Int?, val cause: Throwable)

/** An audio or text track of the current media, for the hidden menu. */
data class TrackOption(val groupIndex: Int, val trackIndex: Int, val language: String?, val label: String?, val selected: Boolean)
