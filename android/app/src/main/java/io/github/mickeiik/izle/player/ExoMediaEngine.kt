package io.github.mickeiik.izle.player

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import okhttp3.OkHttpClient

/** Owns Media3's decoder and transport choices; playback recovery belongs to the controller. */
@OptIn(UnstableApi::class)
class ExoMediaEngine(
    private val context: Context,
    private val mediaHttp: OkHttpClient,
    private val userAgent: String,
    private val capVideoTo720p: Boolean,
) : MediaEngine {
    private var player: ExoPlayer? = null
    private var listener: MediaEngine.Listener? = null
    private var live = false
    private var preferredAudioLanguage: String? = null
    private var subtitlesLanguage: String? = null

    override val surface: Player? get() = player
    override var playWhenReady: Boolean
        get() = player?.playWhenReady ?: false
        set(value) { player?.playWhenReady = value }
    override val isPlaying: Boolean get() = player?.isPlaying == true
    override val positionMs: Long get() = player?.currentPosition ?: 0
    override val durationMs: Long? get() = player?.duration?.takeIf { !live && it != C.TIME_UNSET && it > 0 }
    override val buffering: Boolean get() = player?.playbackState == Player.STATE_BUFFERING

    override fun setListener(listener: MediaEngine.Listener?) { this.listener = listener }

    override fun load(media: MediaSpec, startAtMs: Long?) {
        live = media.live
        val p = ensurePlayer()
        val subtitles = media.subtitles.map { track ->
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(track.url))
                .setMimeType(subtitleMimeType(track.format))
                .setLanguage(track.language)
                .setLabel(track.label)
                .build()
        }
        val item = MediaItem.Builder()
            .setUri(Uri.parse(media.url))
            .setMimeType(mediaMimeType(media.kind))
            .setSubtitleConfigurations(subtitles)
            .setMediaId(media.mediaId)
            .build()
        when {
            restartsInsteadOfResuming(media.kind, live) -> p.setMediaSource(liveStreamSources.createMediaSource(item))
            live || startAtMs == null -> p.setMediaItem(item)
            else -> p.setMediaItem(item, startAtMs)
        }
        p.prepare()
    }

    override fun play() { player?.play() }
    override fun pause() { player?.pause() }
    override fun seekTo(positionMs: Long) { player?.seekTo(positionMs) }
    override fun stop() { player?.stop() }

    override fun release() {
        player?.let {
            it.removeListener(playerListener)
            it.release()
        }
        player = null
    }

    override fun applyPreferences(preferredAudioLanguage: String?, subtitlesLanguage: String?) {
        this.preferredAudioLanguage = preferredAudioLanguage
        this.subtitlesLanguage = subtitlesLanguage
        player?.let(::applyTrackPreferences)
    }

    override fun audioTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_AUDIO)
    override fun textTracks(): List<TrackOption> = tracksOf(C.TRACK_TYPE_TEXT)
    override fun selectAudio(option: TrackOption?) = selectTrack(C.TRACK_TYPE_AUDIO, option)
    override fun selectText(option: TrackOption?) = selectTrack(C.TRACK_TYPE_TEXT, option)

    private fun selectTrack(type: Int, option: TrackOption?) {
        val p = player ?: return
        val builder = p.trackSelectionParameters.buildUpon().clearOverridesOfType(type)
        if (option != null) {
            val group = p.currentTracks.groups.getOrNull(option.groupIndex) ?: return
            builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, option.trackIndex))
        }
        if (type == C.TRACK_TYPE_TEXT) builder.setTrackTypeDisabled(type, option == null)
        p.trackSelectionParameters = builder.build()
    }

    private fun tracksOf(type: Int): List<TrackOption> {
        val p = player ?: return emptyList()
        val textDisabled = type == C.TRACK_TYPE_TEXT && type in p.trackSelectionParameters.disabledTrackTypes
        return p.currentTracks.groups.withIndex().filter { it.value.type == type }.flatMap { (g, group) ->
            (0 until group.length).filter { group.isTrackSupported(it) }.map { t ->
                val format = group.getTrackFormat(t)
                TrackOption(g, t, format.language, format.label, selected = !textDisabled && group.isTrackSelected(t))
            }
        }.distinctBy { it.language to it.label } // adaptive audio renditions repeat the same language
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> listener?.onReady()
                Player.STATE_ENDED -> listener?.onEnded()
            }
            // Every state change refreshes the controller's flags, including ENDED and IDLE after an error.
            listener?.onBufferingChanged(buffering)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            listener?.onPlayWhenReadyChanged(playWhenReady)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) { listener?.onIsPlayingChanged(isPlaying) }

        override fun onPlayerError(error: PlaybackException) {
            listener?.onError(MediaError(error.errorCodeName, error.httpStatus(), error))
        }

        override fun onCues(cueGroup: CueGroup) {
            val text = cueGroup.cues.mapNotNull { it.text?.toString()?.trim() }.filter { it.isNotEmpty() }.joinToString("\n")
            listener?.onCues(text.ifEmpty { null })
        }
    }

    /** Media requests share the app's connection pool and media User-Agent, never the device token. */
    private val dataSources: DataSource.Factory by lazy {
        DefaultDataSource.Factory(context, OkHttpDataSource.Factory(mediaHttp).setUserAgent(userAgent))
    }

    /** A channel's progressive stream: no retry in place, see [restartsInsteadOfResuming]. */
    private val liveStreamSources by lazy { DefaultMediaSourceFactory(dataSources).setLoadErrorHandlingPolicy(NoRetryInPlace()) }

    private fun ensurePlayer(): ExoPlayer = player ?: ExoPlayer.Builder(context)
        .setRenderersFactory(DefaultRenderersFactory(context).setEnableDecoderFallback(true))
        .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            /* handleAudioFocus = */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .build()
        .apply {
            addListener(playerListener)
            applyTrackPreferences(this)
        }
        .also { player = it }

    /**
     * Preferred audio from the server (owner-controlled); subtitles off unless the owner chose a language.
     * Preferences may arrive before the first load, while creating the decoder still has to wait.
     */
    private fun applyTrackPreferences(p: ExoPlayer) {
        val builder = p.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setPreferredAudioLanguages(*languagePreference(preferredAudioLanguage))
            .setPreferredTextLanguages(*languagePreference(subtitlesLanguage))
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subtitlesLanguage == null)
        if (capVideoTo720p) builder.setMaxVideoSize(1280, 720)
        p.trackSelectionParameters = builder.build()
    }

    /** A progressive channel must re-resolve at the live edge instead of issuing a Range retry. */
    private class NoRetryInPlace : DefaultLoadErrorHandlingPolicy() {
        override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET
    }
}
