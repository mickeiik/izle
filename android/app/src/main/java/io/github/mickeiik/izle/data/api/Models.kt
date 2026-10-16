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

@Serializable
data class TvState(
    val version: Long,
    val device: DeviceInfo,
    val catalog: CatalogInfo,
    val home: List<HomeEntry> = emptyList(),
)

/** `autoplayOnStart`: when the TV comes on and shows Home, start the last show after a countdown (owner setting). */
@Serializable
data class DeviceInfo(
    val id: String,
    val name: String,
    val uiLanguage: String = "en",
    val preferredAudioLanguage: String? = null,
    val subtitlesLanguage: String? = null,
    val autoplayOnStart: Boolean = false,
)

@Serializable
data class CatalogInfo(val id: String, val buildId: String, val name: String)

/**
 * `newEpisodes`: playable episodes added to the catalog since the viewer last watched this show (0 when none, and
 * from servers that do not send it). It only labels the tile; what OK plays is [playNext].
 */
@Serializable
data class HomeEntry(val item: ItemCard, @SerialName("continue") val playNext: ContinueInfo, val newEpisodes: Int = 0)

@Serializable
data class ItemCard(val id: String, val kind: String, val title: String, val posterUrl: String? = null)

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

@Serializable
data class ItemDetailsResponse(
    val item: ItemCard,
    val cursorEpisodeId: String? = null,
    val episodes: List<EpisodeDetails> = emptyList(),
)

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

/**
 * `trigger` and `commandId` say who or what started the playback, for the server's viewing history; every resolve of
 * one playback (fallbacks, expiry refreshes, Try again) repeats them. See [io.github.mickeiik.izle.domain.PlaybackOrigin].
 */
@Serializable
data class ResolveRequest(
    val episodeId: String,
    val sourceId: String? = null,
    val exclude: List<String>? = null,
    val trigger: Trigger? = null,
    val commandId: Long? = null,
)

/** A resolve's `trigger`, spelled on the wire as the server expects. */
@Serializable
enum class Trigger {
    @SerialName("viewer") // OK on Home, the hidden menu's episode list or Start over
    Viewer,
    @SerialName("autoplay") // autoplay on start
    Autoplay,
    @SerialName("next") // auto-next, Up next's Play now, CH+/CH−
    Next,
    @SerialName("command") // the owner's play, next or previous, with its `commandId`
    Command,
}

/**
 * What to play. `expiresAt` (ISO 8601) is the stream's validity hint, or null; the TV resolves the same source again
 * shortly before it. [serverDateMs] is not part of the body: it is the answer's `Date` header (the server's clock),
 * filled in by [ApiClient.resolve] so the expiry can be scheduled without trusting the TV's clock.
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
    val episode: EpisodeRef,
    val resume: Resume? = null,
    val expiresAt: String? = null,
    @Transient val serverDateMs: Long? = null,
)

/** `kind` is `hls`, `dash` or `mp4`; `url` may be relative to the server (proxied media). */
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
 * `playing` says whether the player was actually advancing when the position was sampled (false during a rebuffer
 * stall) and `ageMs` how old the sample is when the report is sent: the server anchors "Listen along" on them. Both
 * are omitted when null.
 */
@Serializable
data class ProgressReport(
    val sessionId: String?,
    val episodeId: String,
    val positionMs: Long,
    val durationMs: Long?,
    val status: ProgressStatus,
    val playing: Boolean? = null,
    val ageMs: Long? = null,
)

/** A progress report's `status`, spelled on the wire as the server expects. */
@Serializable
enum class ProgressStatus {
    @SerialName("playing")
    Playing,
    @SerialName("paused")
    Paused,
    @SerialName("stopped") // the viewer left the player before the end
    Stopped,
    @SerialName("finished")
    Finished,
    ;

    /** `stopped` and `finished` are the last word on an episode: Home's tile depends on them. */
    val isFinal: Boolean get() = this == Stopped || this == Finished
}

@Serializable
data class ProgressAck(val ok: Boolean = true, val version: Long = 0)

/**
 * `POST /tv/problems`: something went wrong on this TV, for the owner's admin page. `kind`: `playback`, `resolve`,
 * `network` or `other`; `code` matches `[A-Za-z0-9_.:-]{1,64}`; `ageMs` is how long ago it happened. Never carries
 * URLs, headers, tokens or exception messages (see [io.github.mickeiik.izle.domain.Problems]).
 */
@Serializable
data class ProblemReport(
    val kind: String,
    val code: String,
    val ageMs: Long? = null,
    val episodeId: String? = null,
    val sourceId: String? = null,
    val sessionId: String? = null,
    val positionMs: Long? = null,
    val httpStatus: Int? = null,
    val detail: String? = null,
    val appVersion: String? = null,
)

/**
 * `POST /tv/commands/:id/result`: what became of an owner command, sent once per command after its acknowledgement.
 * `reason` matches `[A-Za-z0-9_.:-]{1,64}`; the server and its consumers accept reasons they do not know.
 */
@Serializable
data class CommandResult(val result: Outcome, val reason: String? = null) {
    @Serializable
    enum class Outcome {
        @SerialName("done")
        Done,
        @SerialName("ignored")
        Ignored,
        @SerialName("failed")
        Failed,
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
    }
}

/** `GET /tv/app`: the TV app version the server stores (`204` when none). [auto]: TVs may install it by themselves. */
@Serializable
data class AppInfo(val versionName: String, val versionCode: Long, val sha256: String, val size: Long, val auto: Boolean = true)

@Serializable
data class PairStart(val code: String, val pairToken: String)

/** `status`: `pending`, `approved` (with the device token, delivered exactly once) or `expired`. */
@Serializable
data class PairWait(val status: String, val deviceId: String? = null, val deviceToken: String? = null)

@Serializable
internal data class ErrorBody(val error: String = "unknown")
