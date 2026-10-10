package io.github.mickeiik.izle.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// DTOs mirroring docs/spec/server-api-v1.md. The server may add response fields within v1, so decoding ignores
// unknown keys and every field the TV can live without has a default.

/** The one Json configuration for the server API (requests omit null fields, responses tolerate new ones). */
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

@Serializable
data class DeviceInfo(
    val id: String,
    val name: String,
    val uiLanguage: String = "en",
    val preferredAudioLanguage: String? = null,
    val subtitlesLanguage: String? = null,
)

@Serializable
data class CatalogInfo(val id: String, val buildId: String, val name: String)

@Serializable
data class HomeEntry(
    val item: ItemCard,
    @SerialName("continue") val playNext: ContinueInfo,
)

@Serializable
data class ItemCard(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int? = null,
    val posterUrl: String? = null,
)

/** What OK on a home tile plays. `status`: `new`, `watching` or `finished` (starts over). */
@Serializable
data class ContinueInfo(
    val episodeId: String,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
    val index: Int = 0,
    val count: Int = 1,
    val positionMs: Long = 0,
    val durationMs: Long? = null,
    val status: String = "new",
)

@Serializable
data class ItemDetailsResponse(
    val item: ItemDetails,
    val cursorEpisodeId: String? = null,
    val episodes: List<EpisodeDetails> = emptyList(),
)

@Serializable
data class ItemDetails(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int? = null,
    val posterUrl: String? = null,
    val originalTitle: String? = null,
    val synopsis: String? = null,
    val genres: List<String> = emptyList(),
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
    val sources: List<SourceInfo> = emptyList(),
)

@Serializable
data class EpisodeProgress(
    val positionMs: Long,
    val durationMs: Long? = null,
    val status: String,
    val updatedAt: String? = null,
)

@Serializable
data class SourceInfo(val id: String, val label: String? = null, val languages: LanguageFacts = LanguageFacts())

/** BCP 47 tags; null = unknown, empty = known none. */
@Serializable
data class LanguageFacts(val audio: List<String>? = null, val subtitles: List<String>? = null)

@Serializable
data class ResolveRequest(
    val episodeId: String,
    val sourceId: String? = null,
    val exclude: List<String>? = null,
)

@Serializable
data class ResolveResponse(
    val sessionId: String,
    val sourceId: String,
    val media: Media,
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
    val languages: LanguageFacts = LanguageFacts(),
    val alternatives: List<String> = emptyList(),
    val next: NextEpisode? = null,
    val item: ItemCard,
    val episode: EpisodeRef,
    val resume: Resume? = null,
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

/** `status`: `playing`, `paused`, `stopped` (left the player) or `finished`. */
@Serializable
data class ProgressReport(
    val sessionId: String?,
    val episodeId: String,
    val positionMs: Long,
    val durationMs: Long?,
    val status: String,
)

@Serializable
data class ProgressAck(val ok: Boolean = true, val version: Long = 0)

@Serializable
data class PairStart(val code: String, val pairToken: String, val expiresAt: String? = null)

/** `status`: `pending`, `approved` (with the device token, delivered exactly once) or `expired`. */
@Serializable
data class PairWait(val status: String, val deviceId: String? = null, val deviceToken: String? = null)

@Serializable
internal data class ErrorBody(val error: String = "unknown")
