package io.github.mickeiik.izle.companion.catalog

import io.github.mickeiik.izle.companion.home.Verdict
import io.github.mickeiik.izle.data.api.AdminSource
import io.github.mickeiik.izle.data.api.CandidateLanguages
import io.github.mickeiik.izle.data.api.CheckStep
import io.github.mickeiik.izle.data.api.CheckedStream
import io.github.mickeiik.izle.data.api.SourceReport
import io.github.mickeiik.izle.data.api.VariantCodecs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A source and its last check in a row's words: what it is, what the check found or why it fails, and its verdict. */
class SourceReportTextTest {
    private val hls = AdminSource("main", "direct", kind = "hls", needsProxy = true, languages = CandidateLanguages(audio = listOf("en", "tr")))

    @Test
    fun whatASourceIs() {
        assertEquals("main · HLS · proxied", sourceKindText(hls))
        assertEquals("file · MP4", sourceKindText(AdminSource("file", "direct", kind = "mp4")))
        assertEquals("live · MPEG-TS", sourceKindText(AdminSource("live", "direct", kind = "ts")))
        assertEquals("fr · adapter example", sourceKindText(AdminSource("fr", "adapter", adapter = "example")))
    }

    @Test
    fun aWorkingSourceSaysItsAudioAndResolution() {
        val report = report(
            "ok",
            codecs = listOf(VariantCodecs(resolution = "640x360"), VariantCodecs(resolution = "1920x1080"), VariantCodecs(resolution = null)),
        )
        assertEquals("audio en, tr · 1080p", sourceFindingsText(hls, report))
        // The stream's languages, when the check saw them, before the catalog's.
        val seen = report.copy(stream = CheckedStream(kind = "hls", languages = CandidateLanguages(audio = listOf("fr"))))
        assertEquals("audio fr · 1080p", sourceFindingsText(hls, seen))
        assertEquals("", sourceFindingsText(AdminSource("x", "direct"), report("ok")))
        assertEquals("through the server", sourceFindingsText(AdminSource("x", "direct"), report("ok").copy(stream = CheckedStream(delivery = "proxy"))))
        assertEquals(Verdict.Works, reportVerdict(report))
    }

    @Test
    fun warningsInWords() {
        val mp4 = AdminSource("file", "direct", kind = "mp4", languages = CandidateLanguages(audio = listOf("en")))
        val report = report("warn", warnings = listOf("no_range"))
        assertEquals("audio en · no range: seeking breaks", sourceFindingsText(mp4, report))
        assertEquals("above 1080p · new thing", sourceFindingsText(null, report("warn", warnings = listOf("high_resolution", "new_thing"))))
        assertEquals(Verdict.Warns, reportVerdict(report))
    }

    @Test
    fun aFailureInWords() {
        val timeout = report(
            "fail",
            steps = listOf(
                CheckStep("playlist", ok = true, status = 200),
                CheckStep("segment", index = 0, of = "variant", ok = false, error = "timeout"),
            ),
        )
        assertEquals("timeout at segment", sourceFindingsText(hls, timeout))
        assertEquals("not media", sourceFindingsText(null, report("fail", steps = listOf(CheckStep("file", ok = false, status = 200, error = "not_media")))))
        assertEquals(
            "HTTP 404 at variant playlist",
            failureText(report("fail", steps = listOf(CheckStep("playlist", ok = true), CheckStep("variant", index = 1, ok = false, status = 404, error = "http")))),
        )
        // It did not resolve: the adapter's reason.
        assertEquals("the adapter found nothing to play", sourceFindingsText(null, report("fail", ok = false, code = "empty")))
        assertEquals("some new code", failureText(report("fail", ok = false, code = "some_new_code")))
        assertEquals(Verdict.Fails, reportVerdict(timeout))
    }

    @Test
    fun notCheckedAndChangedSince() {
        assertEquals("audio en, tr · not checked", sourceFindingsText(hls, null))
        assertEquals("not checked", sourceFindingsText(AdminSource("x", "direct"), null))
        assertEquals(Verdict.NotChecked, reportVerdict(null))
        val stale = report("ok", stale = true)
        assertEquals("audio en, tr · source changed since", sourceFindingsText(hls, stale))
        assertEquals(Verdict.Stale, reportVerdict(stale))
    }

    @Test
    fun resolutionFromTheVariants() {
        assertEquals("720p", resolutionText(report("ok", codecs = listOf(VariantCodecs(resolution = "1280x720")))))
        assertNull(resolutionText(report("ok", codecs = listOf(VariantCodecs(codecs = "avc1.64001f")))))
        assertNull(resolutionText(report("ok")))
    }

    private fun report(
        verdict: String,
        ok: Boolean = true,
        code: String? = null,
        steps: List<CheckStep> = emptyList(),
        codecs: List<VariantCodecs> = emptyList(),
        warnings: List<String> = emptyList(),
        stale: Boolean = false,
    ) = SourceReport("main", "direct", ok = ok, code = code, verdict = verdict, steps = steps, codecs = codecs, warnings = warnings, stale = stale)
}
