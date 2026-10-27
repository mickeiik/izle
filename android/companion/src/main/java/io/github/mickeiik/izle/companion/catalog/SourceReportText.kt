package io.github.mickeiik.izle.companion.catalog

import io.github.mickeiik.izle.companion.home.Verdict
import io.github.mickeiik.izle.companion.ui.mediaKindLabel
import io.github.mickeiik.izle.data.api.AdminSource
import io.github.mickeiik.izle.data.api.CheckStep
import io.github.mickeiik.izle.data.api.SourceReport

// A source of an episode or channel, and what its last check found, in a few words for one row of a show's page or
// an episode's sheet (the admin page's lib.js `sourceReport`, shortened). Never a URL or a header: the server gives none.
// Plain Kotlin: unit-tested without Android.

/** "main · HLS · proxied", "fr · adapter example": the source's id, then what it is. */
fun sourceKindText(source: AdminSource): String = listOfNotNull(
    source.id,
    if (source.type == "adapter") source.adapter?.let { "adapter $it" } ?: "adapter" else source.kind?.let(::mediaKindLabel),
    "proxied".takeIf { source.needsProxy },
).joinToString(" · ")

/**
 * What the last check of [source] found, in one line: "audio en, tr · 1080p", "audio en · 720p · no range: seeking
 * breaks", or why it fails ("timeout at segment", "not media", "the adapter found nothing to play"); "not checked"
 * without a [report]. The audio languages are the stream's when the check saw them, else the catalog's.
 */
fun sourceFindingsText(source: AdminSource?, report: SourceReport?): String {
    val audio = (report?.stream?.languages?.audio ?: source?.languages?.audio)?.takeIf { it.isNotEmpty() }?.let { "audio ${it.joinToString(", ")}" }
    if (report == null) return listOfNotNull(audio, "not checked").joinToString(" · ")
    if (report.verdict == "fail") return failureText(report)
    val parts = listOfNotNull(audio, resolutionText(report)) + report.warnings.map { WARNINGS[it] ?: it.replace('_', ' ') }
    val line = parts.ifEmpty { listOf("works") }.joinToString(" · ")
    return if (report.stale) "$line · source changed since" else line
}

/** Why a source fails: it did not resolve (the adapter's reason), else its first failed step ("timeout at segment"). */
fun failureText(report: SourceReport): String {
    if (!report.ok) return report.code?.let { TRIED[it] ?: it.replace('_', ' ') } ?: "did not resolve"
    val step = report.steps.firstOrNull { !it.ok } ?: return "fails"
    return stepFailureText(step)
}

/** "timeout at segment", "HTTP 404 at variant playlist", "not media" (a file is the stream itself: no "at"). */
fun stepFailureText(step: CheckStep): String {
    val error = step.error
    val why = when {
        error == "http" && step.status != null -> "HTTP ${step.status}"
        error != null -> STEP_ERRORS[error] ?: error.replace('_', ' ')
        step.status != null -> "HTTP ${step.status}"
        else -> "failed"
    }
    if (step.what == "file") return why
    return "$why at ${STEPS[step.what] ?: step.what}"
}

/** The best variant's height as "1080p", "720p"; null without a master playlist's resolutions. */
fun resolutionText(report: SourceReport): String? = report.codecs
    .mapNotNull { v -> v.resolution?.substringAfter('x', "")?.toIntOrNull() }
    .maxOrNull()
    ?.let { "${it}p" }

/** A report's verdict as Home's [Verdict] (a report the source changed since says nothing any more). */
fun reportVerdict(report: SourceReport?): Verdict = when {
    report == null -> Verdict.NotChecked
    report.stale -> Verdict.Stale
    report.verdict == "fail" -> Verdict.Fails
    report.verdict == "warn" -> Verdict.Warns
    else -> Verdict.Works
}

/** Why a source did not resolve (`code` of a tried source). */
private val TRIED = mapOf(
    "empty" to "the adapter found nothing to play",
    "timeout" to "timeout resolving",
    "abort" to "cancelled",
    "error" to "the adapter failed",
    "adapter_unavailable" to "no resolver module provides this adapter",
    "unsupported" to "cannot be served (DASH with headers)",
)

/** What a step fetched. */
private val STEPS = mapOf(
    "playlist" to "playlist",
    "variant" to "variant playlist",
    "rendition" to "rendition playlist",
    "segment" to "segment",
    "init" to "init segment",
    "key" to "key",
    "subtitle" to "subtitles",
    "manifest" to "manifest",
)

/** Why a step failed (`http`: its status says it). */
private val STEP_ERRORS = mapOf(
    "timeout" to "timeout",
    "network" to "no connection",
    "not_a_playlist" to "not a playlist",
    "too_large" to "too large",
    "not_media" to "not media",
    "bad_key" to "bad key",
    "egress_denied" to "refused by the egress policy",
    "not_subtitles" to "not subtitles",
    "not_mpd" to "not a DASH manifest",
    "aborted" to "cancelled",
    "budget" to "out of time",
    "bad_uri" to "a link the TV cannot fetch",
)

/** A warning: it works, but something may still go wrong on the TV. */
private val WARNINGS = mapOf(
    "risky_codec" to "a codec some TVs cannot decode",
    "high_resolution" to "above 1080p",
    "sample_aes" to "SAMPLE-AES: may not play",
    "no_range" to "no range: seeking breaks",
    "subtitle_failed" to "subtitles failed",
    "manifest_only" to "only the manifest checked",
    "playlists_unchecked" to "some playlists not checked",
)
