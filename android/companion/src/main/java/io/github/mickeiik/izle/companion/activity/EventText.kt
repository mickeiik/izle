package io.github.mickeiik.izle.companion.activity

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.device.problemTitle
import io.github.mickeiik.izle.companion.tv.commandReasonWords
import io.github.mickeiik.izle.companion.tv.episodeName
import io.github.mickeiik.izle.companion.tv.formatClock
import io.github.mickeiik.izle.data.api.AdminEvent
import io.github.mickeiik.izle.data.api.EventActor
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

// A TV's event log in words (docs/ux/companion-tv.md, Activity): one line per event, who did it at the end of the
// supporting line. Pure: unit-tested on events as the server sends them.

/** The event types the Activity shows (and fetches): the noisy ones are left out. */
val ACTIVITY_TYPES = listOf(
    "playback.started", "playback.ended", "playback.stalled", "episode.seen",
    "command.sent", "command.result",
    "home.changed", "cursor.changed", "device.updated",
    "problem.recorded", "check.finished",
    "device.online", "device.offline", "device.paired", "device.app_version", "phone.connected",
    "catalog.reloaded",
)

/** The Activity's filter chips, each the [types] it fetches. */
enum class ActivityFilter(val types: List<String>) {
    Everything(ACTIVITY_TYPES),
    Playing(listOf("playback.started", "playback.ended", "playback.stalled", "episode.seen")),
    Remote(listOf("command.sent", "command.result")),
    Home(listOf("home.changed", "cursor.changed")),
    Problems(listOf("problem.recorded", "check.finished")),
    Connection(listOf("device.online", "device.offline", "device.paired", "device.app_version", "phone.connected")),
}

fun filterLabel(res: Resources, filter: ActivityFilter): String = res.getString(
    when (filter) {
        ActivityFilter.Everything -> R.string.activity_filter_everything
        ActivityFilter.Playing -> R.string.activity_filter_playing
        ActivityFilter.Remote -> R.string.activity_filter_remote
        ActivityFilter.Home -> R.string.activity_filter_home
        ActivityFilter.Problems -> R.string.activity_filter_problems
        ActivityFilter.Connection -> R.string.activity_filter_connection
    },
)

/** What an episode is called: from the `playback.started` that began it, or from the catalog. */
data class EpisodeRef(
    val itemTitle: String?,
    val season: Int? = null,
    val number: Int? = null,
    val label: String? = null,
    val title: String? = null,
)

/** An event in words: the row's [title], its [supporting] line (null: none); [problem] draws the title in `danger`. */
data class EventWords(val title: String, val supporting: String?, val problem: Boolean = false)

/**
 * What the words need beyond the event: this phone (its events say "your phone"), what each viewing played (from its
 * `playback.started`), and the episodes and shows the catalog named.
 */
data class EventContext(
    val thisPhoneId: String? = null,
    val viewings: Map<Long, EpisodeRef> = emptyMap(),
    val episodes: Map<String, EpisodeRef> = emptyMap(),
    val items: Map<String, String> = emptyMap(),
)

/** What a `playback.started` played, for the events of its viewing; null for another type. */
fun startedRef(event: AdminEvent): Pair<Long, EpisodeRef>? {
    if (event.type != "playback.started") return null
    val d = event.data
    val viewingId = d.long("viewingId") ?: return null
    return viewingId to EpisodeRef(d.string("itemTitle") ?: d.string("itemId"), d.int("season"), d.int("number"), title = d.string("episodeTitle"))
}

/** This context with what [events]' `playback.started` name: each viewing's episode, and the episode by its id. */
fun EventContext.learn(events: List<AdminEvent>): EventContext {
    val started = events.mapNotNull { e -> startedRef(e)?.let { (viewingId, ref) -> Triple(viewingId, e.data.string("episodeId"), ref) } }
    if (started.isEmpty()) return this
    return copy(
        viewings = viewings + started.map { (v, _, ref) -> v to ref },
        episodes = started.mapNotNull { (_, ep, ref) -> ep?.let { it to ref } }.toMap() + episodes,
    )
}

/**
 * Whether the Activity shows [event] ([eventWords] is not null): a type it lists, and not a command done, a check of
 * no TV, an app version without one, or a start without its viewing.
 */
fun shownInActivity(event: AdminEvent): Boolean {
    val d = event.data
    return when (event.type) {
        !in ACTIVITY_TYPES -> false
        "playback.started" -> d.long("viewingId") != null
        "command.result" -> d.string("result").let { it != null && it != "done" }
        "check.finished" -> event.deviceId != null
        "device.app_version" -> d.string("to") != null
        else -> true
    }
}

/**
 * [event] in words, or null when the Activity does not show it (an unknown type, a command done, a check of another
 * TV's Home or of a show).
 */
fun eventWords(res: Resources, event: AdminEvent, ctx: EventContext = EventContext()): EventWords? {
    if (!shownInActivity(event)) return null
    val d = event.data
    val by = actorText(res, event.actor, ctx.thisPhoneId)
    fun line(vararg parts: String?): String? = listOfNotNull(*parts).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { null }
    fun at(id: Int, none: Int, ms: Long?) = if (ms == null) res.getString(none) else res.getString(id, formatClock(ms))
    val viewing = d.long("viewingId")?.let { ctx.viewings[it] }
    return when (event.type) {
        "playback.started" -> {
            val (_, ref) = startedRef(event) ?: return null
            val live = d.string("itemKind") == "live"
            val from = d.long("positionMs")?.takeIf { it > 0 && !live }?.let { res.getString(R.string.activity_from, formatClock(it)) }
            val trigger = triggerText(res, d.string("trigger"), live, event.actor, ctx.thisPhoneId)
            // The TV's own start says how it started; a command's says who sent it.
            val who = if (event.actor?.type == EventActor.TV || d.string("trigger") == "command") null else by
            EventWords(res.getString(R.string.activity_started, playedText(ref)), line(from, trigger, who))
        }
        "playback.ended" -> {
            val ms = d.long("positionMs")
            val title = when (d.string("endReason")) {
                "finished" -> res.getString(R.string.activity_watched_to_end)
                "replaced" -> at(R.string.activity_switched_away_at, R.string.activity_switched_away, ms)
                "lost" -> at(R.string.activity_went_silent_at, R.string.activity_went_silent, ms)
                else -> at(R.string.activity_stopped_at, R.string.activity_stopped, ms)
            }
            val seen = res.getString(R.string.activity_seen_word).takeIf { d.bool("seen") == true && d.string("endReason") != "finished" }
            EventWords(title, line(viewing?.let(::playedText), seen, by))
        }
        "playback.stalled" ->
            EventWords(at(R.string.activity_stalled_at, R.string.activity_stalled, d.long("positionMs")), line(viewing?.let(::playedText), by))
        "episode.seen" -> {
            val ref = d.string("episodeId")?.let { ctx.episodes[it] } ?: viewing
            val short = ref?.let(::shortEpisode)
            val title = if (short != null) res.getString(R.string.activity_marked_seen, short) else res.getString(R.string.activity_marked_seen_plain)
            val show = ref?.itemTitle ?: d.string("itemId")?.let { ctx.items[it] }
            EventWords(title, line(show, by))
        }
        "command.sent" -> {
            val offline = res.getString(R.string.activity_sent_offline).takeIf { d.bool("online") == false }
            EventWords(res.getString(R.string.activity_sent, commandName(res, d.string("type"))), line(offline, by))
        }
        "command.result" -> {
            val result = d.string("result")
            if (result == null || result == "done") return null
            val type = d.string("type").orEmpty()
            val verb = commandVerb(res, type)
            val why = commandReasonWords(type, d.string("reason"))
            val failed = result == "failed"
            val title = when {
                why == null -> res.getString(if (failed) R.string.activity_couldnt else R.string.activity_didnt, verb)
                else -> res.getString(if (failed) R.string.activity_couldnt_why else R.string.activity_didnt_why, verb, why)
            }
            EventWords(title, null)
        }
        "home.changed" -> {
            val added = d.array("added")
            val removed = d.array("removed")
            val title = if (added == 0 && removed == 0) res.getString(R.string.activity_home_rearranged) else {
                val counts = listOfNotNull(
                    added.takeIf { it > 0 }?.let { res.getQuantityString(R.plurals.activity_home_added, it, it) },
                    removed.takeIf { it > 0 }?.let { res.getString(R.string.activity_home_removed, it) },
                )
                res.getString(R.string.activity_home_changed, counts.joinToString(", "))
            }
            EventWords(title, line(by))
        }
        "cursor.changed" -> {
            val ref = d.string("episodeId")?.let { ctx.episodes[it] }
            val short = ref?.let(::shortEpisode)
            val title = if (short != null) res.getString(R.string.activity_continues_from, short) else res.getString(R.string.activity_continues_plain)
            EventWords(title, line(ref?.itemTitle ?: d.string("itemId")?.let { ctx.items[it] }, by))
        }
        "device.updated" -> {
            val fields = (d["fields"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            val names = fields.map { settingName(res, it) }.distinct()
            val title = if (names.isEmpty()) res.getString(R.string.activity_settings_plain) else res.getString(R.string.activity_settings, names.joinToString(", "))
            EventWords(title, line(by))
        }
        "problem.recorded" -> {
            val words = problemTitle(res, d.string("kind").orEmpty(), d.string("code").orEmpty())
            val ref = d.string("episodeId")?.let { ctx.episodes[it] }
            val what = ref?.let(::playedText) ?: d.string("itemId")?.let { ctx.items[it] }
            EventWords(res.getString(R.string.activity_problem, words), what, problem = true)
        }
        "check.finished" -> {
            // A show's check is no TV's; another TV's Home check does not pass the device filter.
            if (event.deviceId == null) return null
            val title = if (d.string("state") == "cancelled") res.getString(R.string.activity_check_cancelled) else {
                val failed = d.int("failed") ?: 0
                val warned = d.int("warned") ?: 0
                val counts = listOfNotNull(
                    failed.takeIf { it > 0 }?.let { res.getString(R.string.activity_check_fail, it) },
                    warned.takeIf { it > 0 }?.let { res.getString(R.string.activity_check_warn, it) },
                ).ifEmpty { listOf(res.getString(R.string.activity_check_all_work)) }
                res.getString(R.string.activity_check, counts.joinToString(", "))
            }
            EventWords(title, line(by))
        }
        "device.online" -> EventWords(res.getString(R.string.activity_online), null)
        "device.offline" -> EventWords(res.getString(R.string.activity_offline), null)
        "device.paired" -> EventWords(
            res.getString(if (d.bool("replaced") == true) R.string.activity_paired_replaced else R.string.activity_paired),
            d.string("name"),
        )
        "device.app_version" -> {
            val to = d.string("to") ?: return null
            val from = d.string("from")
            val title = if (from == null || from == to) res.getString(R.string.activity_app, to) else res.getString(R.string.activity_app_changed, from, to)
            EventWords(title, null)
        }
        "phone.connected" -> {
            val name = d.string("name") ?: event.actor?.name ?: res.getString(R.string.activity_actor_a_phone)
            EventWords(res.getString(R.string.activity_phone_connected, name), null)
        }
        "catalog.reloaded" -> {
            val added = (d["added"] as? JsonObject)?.int("items") ?: 0
            val removed = (d["removed"] as? JsonObject)?.int("items") ?: 0
            val counts = listOfNotNull(
                added.takeIf { it > 0 }?.let { res.getQuantityString(R.plurals.activity_catalog_added, it, it) },
                removed.takeIf { it > 0 }?.let { res.getString(R.string.activity_home_removed, it) },
            )
            val title = if (counts.isEmpty()) res.getString(R.string.activity_catalog_reloaded)
            else res.getString(R.string.activity_catalog_reloaded_counts, counts.joinToString(", "))
            EventWords(title, line(by))
        }
        else -> null
    }
}

/** Who did it, for the end of a line: "your phone", "Pixel 8", "admin page", "a token: Home bot", "the TV". */
fun actorText(res: Resources, actor: EventActor?, thisPhoneId: String?): String? = when (actor?.type) {
    null -> null
    EventActor.PHONE ->
        if (actor.phoneId != null && actor.phoneId == thisPhoneId) res.getString(R.string.activity_actor_your_phone)
        else actor.name ?: res.getString(R.string.activity_actor_a_phone)
    EventActor.OWNER -> res.getString(R.string.activity_actor_owner)
    EventActor.TOKEN -> actor.name?.let { res.getString(R.string.activity_actor_token, it) } ?: res.getString(R.string.activity_actor_token_unnamed)
    EventActor.TV -> res.getString(R.string.activity_actor_tv)
    EventActor.SERVER -> res.getString(R.string.activity_actor_server)
    else -> actor.type.ifEmpty { null }
}

/** How a playback started: "OK on Home", "autoplay on start", "auto-next", "played from your phone". */
private fun triggerText(res: Resources, trigger: String?, live: Boolean, actor: EventActor?, thisPhoneId: String?): String? = when (trigger) {
    "viewer" -> res.getString(R.string.activity_trigger_viewer)
    "autoplay" -> res.getString(R.string.activity_trigger_autoplay)
    "next" -> res.getString(if (live) R.string.activity_trigger_channel else R.string.activity_trigger_next)
    "command" -> when (actor?.type) {
        EventActor.PHONE -> res.getString(R.string.activity_played_from, actorText(res, actor, thisPhoneId))
        EventActor.OWNER -> res.getString(R.string.activity_played_from_admin)
        EventActor.TOKEN -> res.getString(R.string.activity_played_by, actorText(res, actor, thisPhoneId))
        else -> res.getString(R.string.activity_played_by_command)
    }
    else -> null
}

/** "S1 · E2", the catalog's label, "Episode 5"; null for a film or a channel. */
fun shortEpisode(ref: EpisodeRef): String? =
    if (ref.label == null && ref.number == null) null else episodeName(ref.season, ref.number, ref.label, null)

/** "Caminandes · S1 · E2", a film's or channel's title alone. */
fun playedText(ref: EpisodeRef): String {
    val episode = shortEpisode(ref) ?: ref.title?.takeIf { it != ref.itemTitle }
    return listOfNotNull(ref.itemTitle, episode).joinToString(" · ").ifEmpty { "?" }
}

/** A sent command's name: "play", "a message". */
private fun commandName(res: Resources, type: String?): String = when (type) {
    "play" -> res.getString(R.string.activity_cmd_play)
    "stop" -> res.getString(R.string.activity_cmd_stop)
    "pause" -> res.getString(R.string.activity_cmd_pause)
    "resume" -> res.getString(R.string.activity_cmd_resume)
    "seek" -> res.getString(R.string.activity_cmd_seek)
    "next" -> res.getString(R.string.activity_cmd_next)
    "previous" -> res.getString(R.string.activity_cmd_previous)
    "message" -> res.getString(R.string.activity_cmd_message)
    "update" -> res.getString(R.string.activity_cmd_update)
    null -> "?"
    else -> type.replace('_', ' ')
}

/** What a command does, after "Couldn't": "play", "skip ahead", "show the message". */
private fun commandVerb(res: Resources, type: String): String = when (type) {
    "next" -> res.getString(R.string.activity_verb_next)
    "previous" -> res.getString(R.string.activity_verb_previous)
    "message" -> res.getString(R.string.activity_verb_message)
    "update" -> res.getString(R.string.activity_verb_update)
    "" -> res.getString(R.string.activity_verb_unknown)
    else -> commandName(res, type)
}

/** A setting's name, as the TV tab's rows call it. */
private fun settingName(res: Resources, field: String): String = when (field) {
    "name" -> res.getString(R.string.activity_setting_name)
    "uiLanguage" -> res.getString(R.string.activity_setting_menu_language)
    "preferredAudioLanguage" -> res.getString(R.string.activity_setting_audio)
    "subtitlesLanguage" -> res.getString(R.string.activity_setting_subtitles)
    "autoplayOnStart" -> res.getString(R.string.activity_setting_play_on_start)
    "homeColumns", "homeRows" -> res.getString(R.string.activity_setting_grid)
    else -> field
}

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
private fun JsonObject.array(key: String): Int = (this[key] as? JsonArray)?.size ?: 0
