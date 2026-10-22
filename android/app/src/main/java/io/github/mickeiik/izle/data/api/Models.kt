package io.github.mickeiik.izle.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json

// DTOs of docs/spec/server-api-v1.md, with the fields the TV reads. The server may add response fields within v1:
// decoding ignores unknown keys, requests omit null fields, and every field the TV can live without has a default.
val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/** `home` in Home order (autoplay's first tile, CH+/CH−); [io.github.mickeiik.izle.domain.HomeSections] cuts it. */
@Serializable
data class TvState(
    val version: Long,
    val device: DeviceInfo,
    val catalog: CatalogInfo,
    val home: List<HomeEntry> = emptyList(),
    val homeSections: List<HomeSectionInfo> = emptyList(),
)

/** [layout] `grid` or `row` (any other value is a grid); [itemIds]: entries of `home`, in order. */
@Serializable
data class HomeSectionInfo(
    val id: String,
    val title: String? = null,
    val layout: String = LAYOUT_GRID,
    val itemIds: List<String> = emptyList(),
) {
    companion object {
        const val LAYOUT_GRID = "grid"
        const val LAYOUT_ROW = "row"
    }
}

/** `homeColumns` × `homeRows`: the cards one screen of Home shows, clamped by [io.github.mickeiik.izle.ui.home.HomeGrid]. */
@Serializable
data class DeviceInfo(
    val id: String,
    val name: String,
    val uiLanguage: String = "en",
    val preferredAudioLanguage: String? = null,
    val subtitlesLanguage: String? = null,
    val autoplayOnStart: Boolean = false,
    val homeColumns: Int = 4,
    val homeRows: Int = 2,
)

@Serializable
data class CatalogInfo(val id: String, val buildId: String, val name: String)

/** [playNext] (`continue`): the episode OK plays, null for a channel. `newEpisodes` only labels the tile. */
@Serializable
data class HomeEntry(val item: ItemCard, @SerialName("continue") val playNext: ContinueInfo? = null, val newEpisodes: Int = 0)

/** `kind`: `movie`, `series` or `live` (a channel). `posterUrl` (2:3) and `backdropUrl` (16:9) are server-relative. */
@Serializable
data class ItemCard(val id: String, val kind: String, val title: String, val posterUrl: String? = null, val backdropUrl: String? = null) {
    /** A channel: no episodes, no position, played at its live edge and resolved by its item id. */
    val isLive: Boolean get() = kind == KIND_LIVE

    companion object {
        const val KIND_LIVE = "live"
    }
}

/** What OK on a home tile plays. `status`: `new`, `watching` or `finished` (starts over). */
@Serializable
data class ContinueInfo(
    val episodeId: String,
    val season: Int? = null,
    val number: Int? = null,
    val label: String? = null,
    val index: Int = 0,
    val positionMs: Long = 0,
    val durationMs: Long? = null,
    val status: String = "new",
)

/** `GET /tv/items/:itemId` (never for a channel). */
@Serializable
data class ItemDetailsResponse(val item: ItemCard, val cursorEpisodeId: String? = null, val episodes: List<EpisodeDetails> = emptyList())

@Serializable
data class EpisodeDetails(
    val id: String,
    val index: Int,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
    val durationMs: Long? = null,
    val playbackAllowed: Boolean = false,
    val progress: EpisodeProgress? = null,
)

@Serializable
data class EpisodeProgress(val positionMs: Long, val status: String)

/** Exactly one of [episodeId] and [itemId] (a channel); see [io.github.mickeiik.izle.domain.PlaybackOrigin]. */
@Serializable
data class ResolveRequest(
    val episodeId: String? = null,
    val itemId: String? = null,
    val sourceId: String? = null,
    val exclude: List<String>? = null,
    val trigger: Trigger? = null,
    val commandId: Long? = null,
) {
    init {
        require((episodeId == null) != (itemId == null)) { "an episode or a channel" }
    }
}

@Serializable
enum class Trigger {
    @SerialName("viewer") Viewer, // OK on Home, the hidden menu's episode list or Start over
    @SerialName("autoplay") Autoplay,
    @SerialName("next") Next, // auto-next, Up next's Play now, CH+/CH−
    @SerialName("command") Command, // the owner's play, next or previous, with its `commandId`
}

/**
 * A channel has no [episode], [next] or [resume]. `expiresAt` (ISO 8601): the stream's validity hint. [serverDateMs]
 * is the answer's `Date` header, filled in by [ApiClient.resolve] so the expiry need not trust the TV's clock.
 */
@Serializable
data class ResolveResponse(
    val sessionId: String,
    val sourceId: String,
    val media: Media,
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
    val alternatives: List<String> = emptyList(),
    val next: NextEpisode? = null,
    val item: ItemCard,
    val episode: EpisodeRef? = null,
    val resume: Resume? = null,
    val expiresAt: String? = null,
    @Transient val serverDateMs: Long? = null,
)

/** `kind`: `hls`, `dash`, `mp4` or `ts` (progressive MPEG-TS); `url` may be server-relative (proxied media). */
@Serializable
data class Media(val kind: String, val url: String)

@Serializable
data class SubtitleTrack(val url: String, val language: String, val format: String, val label: String? = null)

@Serializable
data class NextEpisode(
    val episodeId: String,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
)

@Serializable
data class EpisodeRef(
    val id: String,
    val index: Int = 0,
    val count: Int = 1,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
    val durationMs: Long? = null,
)

@Serializable
data class Resume(val positionMs: Long, val durationMs: Long? = null)

/**
 * `POST /tv/progress`. The server anchors "Listen along" on `playing` (whether the player advanced when sampled: false
 * during a stall) and `ageMs` (how old the sample is when sent).
 */
@Serializable
data class ProgressReport(
    val sessionId: String?,
    val episodeId: String? = null,
    val itemId: String? = null,
    val positionMs: Long? = null,
    val durationMs: Long? = null,
    val status: ProgressStatus,
    val playing: Boolean? = null,
    val ageMs: Long? = null,
) {
    companion object {
        fun episode(sessionId: String?, episodeId: String, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) =
            ProgressReport(sessionId, episodeId = episodeId, positionMs = positionMs.coerceAtLeast(0), durationMs = durationMs, status = status, playing = playing)

        /** No position, and only `playing` or `stopped`: a channel is never paused and never finishes. */
        fun channel(sessionId: String?, itemId: String, status: ProgressStatus, playing: Boolean) = ProgressReport(
            sessionId,
            itemId = itemId,
            status = if (status.isFinal) ProgressStatus.Stopped else ProgressStatus.Playing,
            playing = playing,
        )
    }
}

@Serializable
enum class ProgressStatus {
    @SerialName("playing") Playing,
    @SerialName("paused") Paused,
    @SerialName("stopped") Stopped, // the viewer left the player before the end
    @SerialName("finished") Finished,
    ;

    /** The last word on an episode: Home's tile depends on them. */
    val isFinal: Boolean get() = this == Stopped || this == Finished
}

/** `POST /tv/problems`, for the owner's admin page; built by [io.github.mickeiik.izle.domain.Problems]. */
@Serializable
data class ProblemReport(
    val kind: String,
    val code: String,
    val ageMs: Long? = null,
    /** A channel's (an episode is named by [episodeId] alone). */
    val itemId: String? = null,
    val episodeId: String? = null,
    val sourceId: String? = null,
    val sessionId: String? = null,
    val positionMs: Long? = null,
    val httpStatus: Int? = null,
    val detail: String? = null,
    val appVersion: String? = null,
)

/** `POST /tv/commands/:id/result`, once per command after its acknowledgement; servers accept unknown reasons. */
@Serializable
data class CommandResult(val result: Outcome, val reason: String? = null) {
    @Serializable
    enum class Outcome {
        @SerialName("done") Done,
        @SerialName("ignored") Ignored,
        @SerialName("failed") Failed,
    }

    companion object {
        val Done = CommandResult(Outcome.Done)

        fun done(reason: String) = CommandResult(Outcome.Done, reason)

        fun ignored(reason: String) = CommandResult(Outcome.Ignored, reason)

        fun failed(reason: String) = CommandResult(Outcome.Failed, reason)

        // The spec's reasons.
        const val NOT_IN_PLAYER = "not_in_player" // a transport command without video showing
        const val NOT_READY = "not_ready" // the pairing or server address screen
        const val NO_EPISODE = "no_episode" // next/previous at the end of the item
        const val LIVE = "live" // pause, resume or seek while a channel plays: a channel is never paused
        const val NO_CHANNEL = "no_channel" // next/previous with no channel after / before the playing one on Home
        const val UNKNOWN_TYPE = "unknown_type" // a type this TV does not know, or an unusable payload
        const val NO_PLAYABLE_SOURCE = "no_playable_source" // a play whose resolve found nothing
        const val PLAYBACK_ERROR = "playback_error" // a play that failed in the player

        // This TV's own (see docs/decisions.md).
        const val SUPERSEDED = "superseded" // another playback (or episode step) started before this one ran
        const val STOPPED = "stopped" // the player was left (Back, stop, standby) before the playback ran
        const val BUSY = "busy" // next/previous while an earlier step is still fetching the episode list
        const val EPISODES_UNAVAILABLE = "episodes_unavailable" // next/previous: the episode list could not be fetched

        // `update` (see docs/decisions.md, "TV app updates: TV side"). BUSY and NOT_READY above apply too.
        const val INSTALLING = "installing" // done: silent, the archive checked out and the install starts
        const val PROMPTED = "prompted" // done: guided, OK was pressed, the archive checked out, the system dialog comes up
        const val UP_TO_DATE = "up_to_date" // ignored: no APK, or not newer than the installed version
        const val NOT_NEWER = "not_newer" // ignored: the downloaded archive is not newer than the installed version
        const val DECLINED = "declined" // ignored: Back (or HOME) on the "press OK" screen
        const val TIMEOUT = "timeout" // ignored: nobody pressed OK within 60 s
        const val DOWNLOAD = "download" // failed: the download broke off or the server refused it
        const val TOO_LARGE = "too_large" // failed: over 64 MiB
        const val VERIFY = "verify" // failed: another SHA-256 than announced
        const val WRONG_PACKAGE = "wrong_package" // failed: not this app
        const val BAD_ARCHIVE = "bad_archive" // failed: not an APK, or another version than announced
        const val INSTALL_PREFIX = "install_" // failed: + the PackageInstaller status (install_failure_storage)
        const val INTERNAL = "internal" // failed: something this TV did not expect went wrong (no crash, Home again)
    }
}

@Serializable
data class PairStart(val code: String, val pairToken: String)

/** `status`: `pending`, `approved` (with the device token, delivered exactly once) or `expired`. */
@Serializable
data class PairWait(val status: String, val deviceId: String? = null, val deviceToken: String? = null)

@Serializable
internal data class ErrorBody(val error: String = "unknown")
