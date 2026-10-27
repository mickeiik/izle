package io.github.mickeiik.izle.companion.ui

import io.github.mickeiik.izle.companion.tv.UNREACHABLE
import io.github.mickeiik.izle.companion.tv.apiErrorText
import io.github.mickeiik.izle.companion.sync.EndReason
import io.github.mickeiik.izle.companion.sync.ListenPhase
import io.github.mickeiik.izle.companion.sync.ListenState
import io.github.mickeiik.izle.companion.sync.ListenSync
import io.github.mickeiik.izle.companion.sync.PASTED_SOURCE_ID
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
 * lib.js's `candidateOptions`: one option per catalog source (`direct` and `adapter`), or one per audio language when a
 * source has two or more, and the `pasted` candidate (the server lists it last) as "a link found on this phone"; any
 * other type is skipped. Unlike the admin page, nothing is disabled: this phone's player plays DASH and MPEG-TS too, so
 * their kind shows as a chip instead.
 */
fun candidateOptions(candidates: List<CompanionCandidate>): List<CandidateOption> = buildList {
    for (c in candidates) {
        if (c.type == PASTED_SOURCE_ID) {
            add(CandidateOption(PASTED_SOURCE_ID, null, FOUND_LINK_LABEL, null))
            continue
        }
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

/** The `pasted` option's label. */
private const val FOUND_LINK_LABEL = "a link found on this phone"

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
    EndReason.Unauthorized -> "This phone was disconnected. Connect it again from the TV."
    EndReason.Interrupted -> "The phone's audio was interrupted (earphones unplugged, or another app took over); listening ended."
    EndReason.Failed -> "Could not start: ${error?.let { apiErrorText(it) ?: it } ?: "something went wrong."}"
    EndReason.LinkExpired ->
        "The link looks expired or obtained from another address: its playlist is far shorter than the episode. Find a new link."
}

/** After "Apply to all episodes". */
fun copiedText(updated: Int): String =
    if (updated == 0) "No other episode has that source." else "Timing copied to $updated other episode${if (updated == 1) "" else "s"}."

const val TIMING_SAVED = "Timing saved for this episode."

/** lib.js's `errorText` for what the Listen along routes answer. */
fun errorText(e: Throwable): String = when (e) {
    is IOException -> UNREACHABLE
    is ApiException -> apiErrorText(e.code) ?: "The server answered: ${e.code}."
    else -> "Something went wrong."
}

