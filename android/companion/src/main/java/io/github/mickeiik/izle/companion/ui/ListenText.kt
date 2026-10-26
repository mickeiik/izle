package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.sync.EndReason
import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.companion.sync.ListenSync
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CompanionCandidate
import io.github.mickeiik.izle.data.api.LinkTiming
import java.io.IOException
import java.math.BigDecimal
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

// The Listen along texts and the pure parts of the screen, ported from server/admin/lib.js and companion.js (the admin
// page's card) so that both say the same. Plain Kotlin: unit-tested without Android.

/**
 * One choice of "Audio on this phone": a source, or one audio language of a source that has several. [kind] is the
 * candidate's media kind (`hls`, `dash`, `mp4`, `ts`; null for an adapter, whose kind is known only once resolved).
 */
data class CandidateOption(val sourceId: String, val language: String?, val label: String, val kind: String?) {
    /** Identity across refreshes (lib.js's `value`). */
    val key: String get() = "$sourceId\u0000${language.orEmpty()}"
}

/** What the two timing fields say, once valid. */
data class LinkTimingInput(val offsetMs: Long, val rate: Double)

/**
 * lib.js's `candidateOptions`: one option per catalog source (`direct` and `adapter`; any other type, `pasted` among
 * them, is skipped), or one per audio language when a source has two or more. Unlike the admin page, nothing is
 * disabled: this phone's player plays DASH and MPEG-TS too, so their kind shows as a chip instead.
 */
fun candidateOptions(candidates: List<CompanionCandidate>): List<CandidateOption> = buildList {
    for (c in candidates) {
        if (c.type != "direct" && c.type != "adapter") continue
        val langs = c.languages.audio
        val perLanguage: List<String?> = if (langs != null && langs.size >= 2) langs else listOf(null)
        for (lang in perLanguage) {
            val parts = mutableListOf(if (c.label != null) "${c.sourceId} — ${c.label}" else c.sourceId)
            when {
                lang != null -> parts += languageLabel(lang)
                langs != null && langs.size == 1 -> parts += languageLabel(langs[0])
                langs != null && langs.isEmpty() -> parts += "no dialogue"
            }
            if (c.current) parts += "the TV's source"
            add(CandidateOption(c.sourceId, lang, parts.joinToString(" · "), c.kind))
        }
    }
}

/**
 * `Italiano (it)`: the language's name in that language (as the admin page's list has them), then the tag; the tag
 * alone when the phone does not know the language.
 */
fun languageLabel(tag: String): String {
    val locale = Locale.forLanguageTag(tag)
    val name = locale.getDisplayLanguage(locale)
    if (name.isBlank() || name.equals(locale.language, ignoreCase = true)) return tag
    return "${name.replaceFirstChar { it.titlecase(locale) }} ($tag)"
}

/** lib.js's `mediaKindLabel`: `HLS`, `DASH`, `MP4`, `MPEG-TS`. */
fun mediaKindLabel(kind: String): String = if (kind == "ts") "MPEG-TS" else kind.uppercase(Locale.ROOT)

/** The largest offset the server stores (±6 h). */
private const val MAX_OFFSET_MS = 6 * 3600 * 1000L

/**
 * companion.js's `timingFromInputs`: the offset in seconds (a decimal comma is fine) and the speed in 0.5–2; null when
 * either is not a valid number. The offset is stored in whole milliseconds.
 */
fun parseTiming(offsetText: String, speedText: String): LinkTimingInput? {
    val offsetSec = number(offsetText) ?: return null
    val rate = number(speedText) ?: return null
    if (rate < 0.5 || rate > 2) return null
    val offsetMs = (offsetSec * 1000).roundToLong()
    if (abs(offsetMs) > MAX_OFFSET_MS) return null
    return LinkTimingInput(offsetMs, rate)
}

private fun number(text: String): Double? =
    text.trim().replace(',', '.').replace('−', '-').toDoubleOrNull()?.takeIf { it.isFinite() }

/** The offset field's text for a stored link: seconds with 3 decimals. */
fun offsetText(link: LinkTiming): String = String.format(Locale.ROOT, "%.3f", link.offsetMs / 1000.0)

/** The speed field's text: `1`, `1.0427`. */
fun speedText(link: LinkTiming): String = BigDecimal(link.rate.toString()).stripTrailingZeros().toPlainString()

/**
 * The sync status under the Listen button: `TV 1:02:05.4 · phone 1:02:05.3 · drift +60 ms · synced · HLS · clock ±20 ms`,
 * each part only when known; `Starting…` before the first one; null while idle.
 */
fun statusLine(state: ListenState): String? {
    if (state.phase == ListenPhase.Idle) return null
    val parts = buildList {
        state.tvPositionMs?.let { add("TV ${ListenSync.formatPosition(it)}") }
        state.phonePositionMs?.let { add("phone ${ListenSync.formatPosition(it)}") }
        state.driftMs?.let { add("drift ${ListenSync.formatDrift(it)}") }
        state.syncLabel?.let { add(it) }
        state.mediaKind?.let { add(mediaKindLabel(it)) }
        state.clockRttMs?.let { add("clock ±${(it / 2.0).roundToLong()} ms") }
    }
    return if (parts.isEmpty()) "Starting…" else parts.joinToString(" · ")
}

/** The nudge row's value: `nudge +0 ms`, `nudge −50 ms`. */
fun nudgeText(nudgeMs: Long): String = "nudge ${ListenSync.formatDrift(nudgeMs.toDouble())}"

/** Why listening ended, for a snackbar; null when the owner stopped it. */
fun endedText(reason: EndReason?, error: String?): String? = when (reason) {
    null, EndReason.Stopped -> null
    EndReason.TvIdle -> "The TV stopped; listening ended."
    EndReason.TvSwitchedToChannel -> "The TV switched to a channel; listening ended."
    EndReason.NoSuchSourceOnNextEpisode -> "The next episode has no such source; listening ended."
    EndReason.StreamKeepsFailing -> "The companion stream keeps failing; listening ended."
    EndReason.Unauthorized -> "The token was not accepted; pair again."
    EndReason.Failed -> "Could not start: ${error?.let { ERRORS[it] ?: it } ?: "something went wrong."}"
}

/** After "Apply to all episodes". */
fun copiedText(updated: Int): String =
    if (updated == 0) "No other episode has that source." else "Timing copied to $updated other episode${if (updated == 1) "" else "s"}."

const val TIMING_SAVED = "Timing saved for this episode."

/** lib.js's `errorText` for what the Listen along routes answer. */
fun errorText(e: Throwable): String = when (e) {
    is IOException -> "The server cannot be reached."
    is ApiException -> ERRORS[e.code] ?: "The server answered: ${e.code}."
    else -> "Something went wrong."
}

private val ERRORS = mapOf(
    "unauthorized" to "The token was not accepted.",
    "insufficient_scope" to "This token may not do that; it needs the companion scope.",
    "not_allowed" to "Playback of that episode is not allowed by the catalog.",
    "unknown_episode" to "That episode is not in the catalog (any more).",
    "unknown_device" to "That TV does not exist any more.",
    "unknown_source" to "That source is not in the catalog (any more).",
    "unsupported_media" to "The server does not offer that source's DASH or MPEG-TS stream to a phone.",
    "no_playable_source" to "The source could not be resolved right now.",
    "no_link" to "Save the timing for this episode first.",
    "invalid_request" to "The server did not accept the request.",
)

