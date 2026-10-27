package io.github.mickeiik.izle.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The admin routes of a TV's page in the companion app (docs/spec/server-api-v1.md, "Devices", "Home list changes",
// "Home sections", "Catalog", "Events"). Same rules as Models.kt: unknown keys ignored, a default for what can be absent.

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

/** A catalog search hit; [episodeCount], [playableCount] and [newEpisodes] are null for a channel. */
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
)

/** [total] counts every match; [items] is the page from [offset]. */
@Serializable
data class CatalogSearch(val items: List<CatalogHit> = emptyList(), val total: Int = 0, val offset: Int = 0)

/** `GET admin/catalog/items/:id`: a series or film with its episodes; a channel has none and [playbackAllowed]. */
@Serializable
data class AdminItem(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int? = null,
    val posterUrl: String? = null,
    val episodes: List<AdminEpisode> = emptyList(),
    val playbackAllowed: Boolean? = null,
)

@Serializable
data class AdminEpisode(
    val id: String,
    val season: Int? = null,
    val number: Int? = null,
    val title: String? = null,
    val label: String? = null,
    val playbackAllowed: Boolean = false,
    val check: CheckSummary? = null,
)

/** An event of the admin log (`home.changed`, `cursor.changed`, …); the app only reacts to its [type]. */
@Serializable
data class AdminEvent(val id: Long, val type: String, val at: String? = null, val deviceId: String? = null)

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
internal data class CommandResponse(val command: CommandInfo)

@Serializable
internal data class ItemResponse(val item: AdminItem)

@Serializable
internal data class RunResponse(val run: CheckRun)

/** `GET admin/checks/current`: null when no run was started since the server started. */
@Serializable
internal data class CurrentRunResponse(val run: CheckRun? = null)
