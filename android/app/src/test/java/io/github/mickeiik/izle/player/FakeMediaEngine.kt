package io.github.mickeiik.izle.player

import java.io.IOException

/** A decoder driven by the test: time and position advance independently, and every load is inspectable. */
class FakeMediaEngine : MediaEngine {
    data class Load(val media: MediaSpec, val startAtMs: Long?)

    val loads = mutableListOf<Load>()
    val calls = mutableListOf<String>()
    val preferences = mutableListOf<Pair<String?, String?>>()
    val audioSelections = mutableListOf<TrackOption?>()
    val textSelections = mutableListOf<TrackOption?>()
    var audio = emptyList<TrackOption>()
    var text = emptyList<TrackOption>()
    private var listener: MediaEngine.Listener? = null
    private var playing = false
    private var ready = false
    override val surface get() = null
    override val isPlaying get() = playing
    override var positionMs = 0L
    override var durationMs: Long? = null
    override var buffering = false
        private set
    override var playWhenReady = false
        set(value) {
            if (field == value) return
            field = value
            listener?.onPlayWhenReadyChanged(value)
            if (ready) setPlaying(value)
        }

    override fun setListener(listener: MediaEngine.Listener?) { this.listener = listener }

    override fun load(media: MediaSpec, startAtMs: Long?) {
        calls += "load"
        loads += Load(media, startAtMs)
        positionMs = startAtMs ?: 0
        ready = false
        buffering = true
        setPlaying(false)
        listener?.onBufferingChanged(true)
    }

    fun ready() {
        ready = true
        buffering = false
        listener?.onReady()
        listener?.onBufferingChanged(false)
        setPlaying(playWhenReady)
    }

    fun ended() {
        ready = false
        listener?.onEnded()
        setPlaying(false)
    }

    fun fail(codeName: String = "ERROR_CODE_DECODING_FAILED", httpStatus: Int? = null) {
        ready = false
        listener?.onError(MediaError(codeName, httpStatus, IOException("decoder failed")))
        setPlaying(false)
    }

    fun setPlaying(value: Boolean) {
        if (playing == value) return
        playing = value
        listener?.onIsPlayingChanged(value)
    }

    fun buffer(value: Boolean) {
        buffering = value
        listener?.onBufferingChanged(value)
        if (value) setPlaying(false)
    }

    fun cues(text: String?) { listener?.onCues(text) }

    fun advancePosition(ms: Long) { if (isPlaying) positionMs += ms }

    override fun play() { calls += "play"; playWhenReady = true }
    override fun pause() { calls += "pause"; playWhenReady = false }
    override fun seekTo(positionMs: Long) { calls += "seek"; this.positionMs = positionMs }
    override fun stop() { calls += "stop"; ready = false; setPlaying(false) }
    override fun release() {
        calls += "release"
        ready = false
        playing = false
        playWhenReady = false
    }

    override fun applyPreferences(preferredAudioLanguage: String?, subtitlesLanguage: String?) {
        preferences += preferredAudioLanguage to subtitlesLanguage
    }
    override fun audioTracks() = audio
    override fun textTracks() = text
    override fun selectAudio(option: TrackOption?) { audioSelections += option }
    override fun selectText(option: TrackOption?) { textSelections += option }
}
