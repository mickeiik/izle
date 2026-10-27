package io.github.mickeiik.izle.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// The admin routes of a TV's page in the companion app (docs/spec/server-api-v1.md, "Pairing", "Devices", "Problem
// reports", "Home list changes", "Home sections", "Catalog", "Status", "Events"). Same rules as Models.kt: unknown
// keys ignored, a default for what can be absent.

/** `effective` of an admin device: the settings the TV runs with (the server's defaults and the catalog's hints applied). */
@Serializable
data class DeviceEffective(
    val uiLanguage: String = "en",
    val preferredAudioLanguage: String? = null,
    val subtitlesLanguage: String? = null,
    val autoplayOnStart: Boolean = false,
    val homeColumns: Int = 4,
    val homeRows: Int = 2,
)

/** `problems` of an admin device: how many reports came in recently, and when the last one did. */
@Serializable
data class DeviceProblems(val recent: Int = 0, val lastAt: String? = null)

/** `settings` of an admin device: the values stored for this TV, null where it follows the default ([DeviceEffective] has the result). */
@Serializable
data class DeviceSettings(
    val uiLanguage: String? = null,
    val preferredAudioLanguage: String? = null,
    val subtitlesLanguage: String? = null,
    val autoplayOnStart: Boolean? = null,
    val homeColumns: Int? = null,
    val homeRows: Int? = null,
)

/**
 * `app` of an admin device, as the TV's User-Agent last reported it (each null until it does): [capability] `silent` or
 * `guided`; [update] `unknown`, `up_to_date`, `pending` (it installs by itself) or `needs_install_now` (send `update`).
 */
@Serializable
data class DeviceApp(
    val version: String? = null,
    val versionCode: Long? = null,
    val androidSdk: Int? = null,
    val capability: String? = null,
    val reportedAt: String? = null,
    val update: String = UPDATE_UNKNOWN,
) {
    companion object {
        const val CAPABILITY_SILENT = "silent"
        const val CAPABILITY_GUIDED = "guided"
        const val UPDATE_UNKNOWN = "unknown"
        const val UPDATE_UP_TO_DATE = "up_to_date"
        const val UPDATE_PENDING = "pending"
        const val UPDATE_NEEDS_INSTALL_NOW = "needs_install_now"
    }
}

/**
 * A change to a TV's settings (`PATCH admin/devices/:id`): null fields stay as they are and are not sent. The language
 * settings take a [SetTo], whose null value resets them (default UI language, the server's audio, subtitles off).
 */
data class DeviceChange(
    val name: String? = null,
    val uiLanguage: SetTo<String?>? = null,
    val preferredAudioLanguage: SetTo<String?>? = null,
    val subtitlesLanguage: SetTo<String?>? = null,
    val autoplayOnStart: Boolean? = null,
    val homeColumns: Int? = null,
    val homeRows: Int? = null,
)

/** The new value of a setting that may be set to null. */
data class SetTo<out T>(val value: T)

/**
 * A problem of a TV (the spec's `Problem`): [origin] `tv` or `server`; [kind] `playback`, `resolve`, `proxy`, `network`
 * or `other`; [at] when it happened. Titles come from the current catalog; [missing] (and null titles) when the episode,
 * or a channel's item, is not in it (any more).
 */
@Serializable
data class Problem(
    val id: Long,
    val at: String? = null,
    val origin: String = ORIGIN_TV,
    val kind: String = "",
    val code: String = "",
    val itemId: String? = null,
    val itemTitle: String? = null,
    val itemKind: String? = null,
    val episodeId: String? = null,
    val episodeTitle: String? = null,
    val season: Int? = null,
    val number: Int? = null,
    val sourceId: String? = null,
    val positionMs: Long? = null,
    val httpStatus: Int? = null,
    val detail: String? = null,
    val appVersion: String? = null,
    val missing: Boolean = false,
) {
    companion object {
        const val ORIGIN_TV = "tv"
        const val ORIGIN_SERVER = "server"
    }
}

/** An open pairing code (`GET admin/pair/pending`); [approved]: approved, the TV has not collected its token yet. */
@Serializable
data class PendingCode(val code: String, val createdAt: String? = null, val expiresAt: String? = null, val approved: Boolean = false)

/** `POST admin/pair/approve`: the device the code pairs (the replaced one's id and name with `replaces`). */
@Serializable
data class ApprovedPairing(val deviceId: String, val name: String)

/**
 * `GET admin/status`: every active TV in one call; [lastEventId] was read first, so the events after it miss nothing.
 * A device's [StatusDevice.nowPlaying] is set while its viewing runs.
 */
@Serializable
data class AdminStatus(
    val serverNowMs: Long = 0,
    val server: ServerInfo? = null,
    val catalog: StatusCatalog? = null,
    val pairing: StatusPairing = StatusPairing(),
    val devices: List<StatusDevice> = emptyList(),
    val lastEventId: Long = 0,
)

@Serializable
data class StatusCatalog(val id: String, val buildId: String)

/** [pending]: open pairing codes. */
@Serializable
data class StatusPairing(val pending: Int = 0)

@Serializable
data class StatusDevice(
    val id: String,
    val name: String,
    val online: Boolean = false,
    val lastSeenAt: String? = null,
    val nowPlaying: NowPlaying? = null,
)

/** A Home section; [id] is `untitled` for the one without a title (always there). [layout] `grid` or `row`. */
@Serializable
data class HomeSection(
    val id: String,
    val title: String? = null,
    val layout: String = HomeSectionInfo.LAYOUT_GRID,
    val itemIds: List<String> = emptyList(),
)

/** The stored check of what OK plays: [verdict] `pass`, `warn` or `fail`; [stale]: a source has no current report. */
@Serializable
data class CheckSummary(
    val verdict: String? = null,
    val checkedAt: String? = null,
    val working: Int = 0,
    val total: Int = 0,
    val stale: Boolean = false,
)

/** The check over every episode that may play; [verdict] is the worst of theirs, null when none was checked. */
@Serializable
data class CheckAll(
    val verdict: String? = null,
    val checked: Int = 0,
    val total: Int = 0,
    val failed: Int = 0,
    val warned: Int = 0,
    val oldestCheckedAt: String? = null,
)

/**
 * One show on a TV's Home as the admin page lists it (not the TV's [HomeEntry]). [title] and [kind] are null for an item
 * gone from the catalog ([missing]); [playable] false when nothing in it may play. [continueAt]: what OK plays, null
 * for a channel or a missing item.
 */
@Serializable
data class AdminHomeEntry(
    val itemId: String,
    val title: String? = null,
    val kind: String? = null,
    val posterUrl: String? = null,
    val backdropUrl: String? = null,
    val missing: Boolean = false,
    val playable: Boolean = true,
    @SerialName("continue") val continueAt: ContinueInfo? = null,
    val newEpisodes: Int = 0,
    val check: CheckSummary? = null,
    val checkAll: CheckAll? = null,
)

/** `GET admin/devices/:id`: [home] in Home order (the sections in order, each with its items). */
@Serializable
data class DeviceDetail(
    val device: AdminDevice,
    val home: List<AdminHomeEntry> = emptyList(),
    val homeMax: Int = 200,
    val sections: List<HomeSection> = emptyList(),
    val sectionsMax: Int = 20,
)

/** The answer of every Home change: the new state [version], the list and the sections as they are now. [sectionId]: a new section's. */
@Serializable
data class HomeChange(
    val version: Long,
    val home: List<AdminHomeEntry> = emptyList(),
    val sections: List<HomeSection> = emptyList(),
    val sectionId: String? = null,
)

/** `POST …/commands`: [online] false = the TV gets the command if it connects within the next 2 minutes. */
@Serializable
data class CommandSent(val id: Long, val online: Boolean = false)

/** A command as the server keeps it: [result] `done`, `ignored` or `failed` (null until the TV reports), with a [reason]. */
@Serializable
data class CommandInfo(
    val id: Long,
    val type: String,
    val createdAt: String? = null,
    val deliveredAt: String? = null,
    val result: String? = null,
    val reason: String? = null,
    val resultAt: String? = null,
)

/**
 * A catalog search hit; [episodeCount], [playableCount] and [newEpisodes] are null for a channel. [newEpisodes]: those
 * first seen at or after the search's `since` (0 without it); [firstSeenAt] is null for what the baseline build carried.
 */
@Serializable
data class CatalogHit(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int? = null,
    val posterUrl: String? = null,
    val episodeCount: Int? = null,
    val playableCount: Int? = null,
    val playable: Boolean = false,
    val newEpisodes: Int? = null,
    val firstSeenAt: String? = null,
)

/** [total] counts every match; [items] is the page from [offset]. */
@Serializable
data class CatalogSearch(val items: List<CatalogHit> = emptyList(), val total: Int = 0, val offset: Int = 0) {
    companion object {
        const val SORT_TITLE = "title"
        const val SORT_YEAR = "year"
        const val SORT_NEWEST = "newest"
    }
}

/**
 * `GET admin/catalog/items/:id`: a series or film with its episodes (and [autoAdvance]); a channel has none, and
 * [playbackAllowed], [sources] and [check] of its own.
 */
@Serializable
data class AdminItem(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int? = null,
    val posterUrl: String? = null,
    val backdropUrl: String? = null,
    val originalTitle: String? = null,
    val synopsis: String? = null,
    val genres: List<String> = emptyList(),
    val autoAdvance: Boolean? = null,
    val episodes: List<AdminEpisode> = emptyList(),
    val playbackAllowed: Boolean? = null,
    val sources: List<AdminSource> = emptyList(),
    val check: CheckSummary? = null,
)

/** In play order; [sources] in the order the TV tries them; [autoAdvance] null: the item's. */
@Serializable
data class AdminEpisode(
    val id: String,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
    val durationMs: Long? = null,
    val playbackAllowed: Boolean = false,
    val autoAdvance: Boolean? = null,
    val sources: List<AdminSource> = emptyList(),
    val check: CheckSummary? = null,
)

/**
 * A source as the admin routes show it, never where it comes from: [type] `direct` (with its media [kind] and
 * [needsProxy]: it has upstream headers) or `adapter` (with its [adapter] id). Null language facts: unknown.
 */
@Serializable
data class AdminSource(
    val id: String,
    val type: String,
    val label: String? = null,
    val languages: CandidateLanguages = CandidateLanguages(),
    val kind: String? = null,
    val needsProxy: Boolean = false,
    val adapter: String? = null,
)

/** `GET admin/devices/:id/progress`: where OK continues each series ([cursors]) and the saved positions ([progress]). */
@Serializable
data class DeviceProgress(val cursors: List<ItemCursor> = emptyList(), val progress: List<SavedProgress> = emptyList()) {
    /**
     * The episode OK plays for [item] on this TV (null for a channel, or when none may play), by the server's play
     * order: the cursor's episode (or the next allowed one after it), else the first allowed one not finished, else the
     * first allowed one. Not known here: episodes appended after the item was watched to the end, which OK plays first;
     * for an item on Home the device detail's `continue` knows them and is the one to use.
     */
    fun okPlays(item: AdminItem): String? {
        val episodes = item.episodes
        val first = episodes.indexOfFirst { it.playbackAllowed }
        if (first < 0) return null
        val cursor = cursors.firstOrNull { it.itemId == item.id }
        val at = cursor?.let { c -> episodes.indexOfFirst { it.id == c.episodeId } } ?: -1
        if (at >= 0) return (episodes.drop(at).firstOrNull { it.playbackAllowed } ?: episodes[first]).id
        val finished = progress.filter { it.itemId == item.id && it.status == SavedProgress.FINISHED }.mapTo(HashSet()) { it.episodeId }
        return (episodes.firstOrNull { it.playbackAllowed && it.id !in finished } ?: episodes[first]).id
    }
}

/** A cursor; titles from the loaded catalog, or [missing] (and no titles) when its episode left it. */
@Serializable
data class ItemCursor(
    val itemId: String,
    val episodeId: String,
    val updatedAt: String? = null,
    val itemTitle: String? = null,
    val kind: String? = null,
    val season: Int? = null,
    val number: Int? = null,
    val episodeTitle: String? = null,
    val missing: Boolean = false,
)

/** A saved position; [status] `watching` or `finished`. Titles as in [ItemCursor]. */
@Serializable
data class SavedProgress(
    val itemId: String,
    val episodeId: String,
    val positionMs: Long = 0,
    val durationMs: Long? = null,
    val status: String = "",
    val updatedAt: String? = null,
    val itemTitle: String? = null,
    val kind: String? = null,
    val season: Int? = null,
    val number: Int? = null,
    val episodeTitle: String? = null,
    val missing: Boolean = false,
) {
    companion object {
        const val FINISHED = "finished"
    }
}

/**
 * `GET admin/catalog` (and what a reload answers): the loaded bundle. [builds] newest first (at most 50); [changes]:
 * those of the newest build that is not the baseline, null when there is none; [resolver] null without a module.
 */
@Serializable
data class AdminCatalog(
    val id: String,
    val buildId: String,
    val builtAt: String? = null,
    val name: String = "",
    val loadedAt: String? = null,
    val stats: CatalogStats = CatalogStats(),
    val adapters: List<String> = emptyList(),
    val warnings: List<CatalogIssue> = emptyList(),
    val resolver: ResolverInfo? = null,
    val server: ServerInfo? = null,
    val builds: List<CatalogBuild> = emptyList(),
    val changes: CatalogChanges? = null,
    val facets: CatalogFacets = CatalogFacets(),
)

/** [items] = [movies] + [series] + [live]. */
@Serializable
data class CatalogStats(
    val items: Int = 0,
    val movies: Int = 0,
    val series: Int = 0,
    val live: Int = 0,
    val episodes: Int = 0,
    val playableEpisodes: Int = 0,
    val sources: Int = 0,
    val posters: Int = 0,
    val backdrops: Int = 0,
)

/** A warning of the loaded bundle, or an issue of one a reload refused ([severity] `error` or `warning`; [path] a JSON pointer). */
@Serializable
data class CatalogIssue(val severity: String? = null, val file: String = "", val path: String = "", val message: String = "")

@Serializable
data class ResolverInfo(val sha256: String, val adapters: List<String> = emptyList())

@Serializable
data class ServerInfo(val version: String)

/**
 * A build in the catalog's history: [counts] what it holds, [added]/[removed] what changed against the one loaded
 * before it. [baseline]: the first build the server loaded for this catalog (nothing in it counts as new).
 */
@Serializable
data class CatalogBuild(
    val buildId: String,
    val builtAt: String? = null,
    val loadedAt: String,
    val baseline: Boolean = false,
    val counts: BuildCounts = BuildCounts(),
    val added: BuildCounts = BuildCounts(),
    val removed: BuildCounts = BuildCounts(),
)

@Serializable
data class BuildCounts(val items: Int = 0, val episodes: Int = 0)

/** What a build changed; each list at most 500 entries, added ones in catalog order. */
@Serializable
data class CatalogChanges(val items: ItemChanges = ItemChanges(), val episodes: EpisodeChanges = EpisodeChanges())

@Serializable
data class ItemChanges(val added: List<ChangedItem> = emptyList(), val removed: List<ChangedItem> = emptyList())

@Serializable
data class EpisodeChanges(val added: List<ChangedEpisode> = emptyList(), val removed: List<ChangedEpisode> = emptyList())

/** [kind] only for an added item; [title] null for a removed one when the catalog before was not in memory. */
@Serializable
data class ChangedItem(val id: String, val title: String? = null, val kind: String? = null)

/** [season], [number], [label] and [playbackAllowed] only for an added episode. */
@Serializable
data class ChangedEpisode(
    val id: String,
    val itemId: String,
    val itemTitle: String? = null,
    val season: Int? = null,
    val number: Int? = null,
    val label: String? = null,
    val playbackAllowed: Boolean = false,
)

/** `GET admin/catalog/builds/:buildId`. */
@Serializable
data class BuildChanges(val build: CatalogBuild, val changes: CatalogChanges = CatalogChanges())

/** Over the whole catalog: genres most common first; [years] null when no film or series has one. */
@Serializable
data class CatalogFacets(val kinds: KindCounts = KindCounts(), val genres: List<GenreCount> = emptyList(), val years: YearRange? = null)

@Serializable
data class KindCounts(val movie: Int = 0, val series: Int = 0, val live: Int = 0)

@Serializable
data class GenreCount(val name: String, val count: Int = 0)

@Serializable
data class YearRange(val min: Int, val max: Int)

/**
 * One source's check (the spec's `SourceReport`): [ok] whether it resolved (in [ms]; [code] and [name] why not),
 * [verdict] `ok`, `warn` or `fail`. [checkedAt] and [stale] (the source changed since) only on a stored report.
 */
@Serializable
data class SourceReport(
    val sourceId: String,
    val type: String = "",
    val adapterId: String? = null,
    val ok: Boolean = false,
    val ms: Long = 0,
    val code: String? = null,
    val name: String? = null,
    val stream: CheckedStream? = null,
    val verdict: String,
    val steps: List<CheckStep> = emptyList(),
    val codecs: List<VariantCodecs> = emptyList(),
    val warnings: List<String> = emptyList(),
    val checkMs: Long = 0,
    val checkedAt: String? = null,
    val stale: Boolean = false,
)

/** The stream a check followed: [kind] `hls`, `mp4`, …; [delivery] `direct`, `proxy` or `unsupported`. */
@Serializable
data class CheckedStream(
    val kind: String? = null,
    val delivery: String? = null,
    val languages: CandidateLanguages? = null,
    val label: String? = null,
)

/**
 * One request of a check: [what] `playlist`, `variant`, `segment`, `file`, …; [index] of the variant, rendition or
 * track ([of] names which for a segment, init or key); [error] `timeout`, `http`, `not_media`, … when not [ok].
 */
@Serializable
data class CheckStep(
    val what: String,
    val index: Int? = null,
    val of: String? = null,
    val host: String? = null,
    val ok: Boolean = false,
    val status: Int? = null,
    val ms: Long = 0,
    val error: String? = null,
    val bytes: Long? = null,
    val container: String? = null,
)

/** A master playlist's variant; [resolution] `1920x1080`. */
@Serializable
data class VariantCodecs(val codecs: String? = null, val resolution: String? = null, val bandwidth: Long? = null)

/** `GET admin/checks/playables/:id`: the stored reports of the sources still in the catalog, in bundle order. [episodeId] null for a channel. */
@Serializable
data class PlayableChecks(
    val itemId: String,
    val episodeId: String? = null,
    val check: CheckSummary? = null,
    val sources: List<SourceReport> = emptyList(),
)

/** `POST admin/diagnostics/resolve`: every source checked now (and stored). [episodeId] null for a channel. */
@Serializable
data class PlayableReport(
    val itemId: String,
    val episodeId: String? = null,
    val playbackAllowed: Boolean = false,
    val verdict: String,
    val checkedAt: String? = null,
    val sources: List<SourceReport> = emptyList(),
)

/** An event of the admin log (`home.changed`, `cursor.changed`, …): who caused it ([actor]) and its type's [data]. */
@Serializable
data class AdminEvent(
    val id: Long,
    val type: String,
    val at: String? = null,
    val deviceId: String? = null,
    val actor: EventActor? = null,
    val data: JsonObject = JsonObject(emptyMap()),
)

/**
 * Who caused an event: [type] `owner`, `phone` ([phoneId], [name] at that moment), `token` ([tokenId], [name]), `tv`
 * ([deviceId]) or `server`; a type the app does not know is kept as it came.
 */
@Serializable
data class EventActor(
    val type: String = "",
    val phoneId: String? = null,
    val tokenId: String? = null,
    val name: String? = null,
    val deviceId: String? = null,
) {
    companion object {
        const val OWNER = "owner"
        const val PHONE = "phone"
        const val TOKEN = "token"
        const val TV = "tv"
        const val SERVER = "server"
    }
}

/** `GET admin/events`: oldest first; [last] is where to follow on from; [gap]: events were lost, reload. */
@Serializable
data class EventsPage(val events: List<AdminEvent> = emptyList(), val last: Long = 0, val gap: Boolean = false)

/** What a check [CheckRun] covers: a show or channel ([itemId]) or a TV's Home ([deviceId], [mode] `quick` or `full`). */
@Serializable
data class CheckTarget(val itemId: String? = null, val deviceId: String? = null, val mode: String? = null)

/** A Home entry a run left out: [reason] `missing` (gone from the catalog) or `not_playable`. [title] null for a missing one. */
@Serializable
data class CheckSkipped(val itemId: String, val title: String? = null, val reason: String = "missing")

/** One episode or channel a run checked, in the order they finished; [label] names a series' episode (`S1 E2 · Pilot`). */
@Serializable
data class CheckResult(
    val playableId: String,
    val itemId: String,
    val episodeId: String? = null,
    val title: String? = null,
    val label: String? = null,
    val verdict: String? = null,
)

/**
 * A batch check (`Run` of the spec's "Checks"): [state] `running`, `done` or `cancelled`; [seq] grows with every change
 * (a long-poll waits past it); [title] is the show's or channel's title, or the TV's name for a Home.
 */
@Serializable
data class CheckRun(
    val id: String,
    val target: CheckTarget = CheckTarget(),
    val title: String = "",
    val state: String = STATE_RUNNING,
    val seq: Long = 0,
    val total: Int = 0,
    val done: Int = 0,
    val failed: Int = 0,
    val warned: Int = 0,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    val skipped: List<CheckSkipped> = emptyList(),
    val results: List<CheckResult> = emptyList(),
) {
    val running: Boolean get() = state == STATE_RUNNING

    companion object {
        const val STATE_RUNNING = "running"
        const val STATE_DONE = "done"
        const val STATE_CANCELLED = "cancelled"
        const val MODE_QUICK = "quick"
        const val MODE_FULL = "full"
    }
}

// Wrappers of single objects.

@Serializable
internal data class DeviceUpdated(val device: AdminDevice)

@Serializable
internal data class ProblemsResponse(val problems: List<Problem> = emptyList())

@Serializable
internal data class PendingCodesResponse(val codes: List<PendingCode> = emptyList())

@Serializable
internal data class CommandResponse(val command: CommandInfo)

@Serializable
internal data class ItemResponse(val item: AdminItem)

@Serializable
internal data class RunResponse(val run: CheckRun)

@Serializable
internal data class CatalogResponse(val catalog: AdminCatalog)

/** `GET admin/checks/current`: null when no run was started since the server started. */
@Serializable
internal data class CurrentRunResponse(val run: CheckRun? = null)
