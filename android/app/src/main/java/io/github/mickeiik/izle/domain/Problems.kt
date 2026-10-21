package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ProblemReport

/**
 * Builds the problem reports the TV sends to `POST /tv/problems`. They are diagnostics for the owner and pass no
 * secrets: exception *messages* are never used (Media3 and OkHttp put request URLs, with their signatures and
 * tokens, into them); only class names, error code names and HTTP statuses go out.
 */
object Problems {
    const val MAX_CODE_CHARS = 64
    const val MAX_DETAIL_CHARS = 500
    const val MAX_APP_VERSION_CHARS = 40
    const val MAX_AGE_MS = 86_400_000L

    /** Only reported when the outage lasted at least this long (and once the server answers again). */
    const val SERVER_UNREACHABLE_MIN_MS = 5 * 60_000L

    private val CODE_CHAR = Regex("[A-Za-z0-9_.:-]")

    /** The server's code syntax: `[A-Za-z0-9_.:-]{1,64}`; anything else becomes `_`. */
    fun code(raw: String): String {
        val cleaned = raw.trim().map { if (CODE_CHAR.matches(it.toString())) it else '_' }.joinToString("").take(MAX_CODE_CHARS)
        return cleaned.ifEmpty { "unknown" }
    }

    /** `ExoPlaybackException < InvalidResponseCodeException`: the exception and its causes, class names only. */
    fun classChain(error: Throwable, max: Int = 4): String {
        val names = mutableListOf<String>()
        var current: Throwable? = error
        while (current != null && names.size < max) {
            names += current.javaClass.simpleName.ifEmpty { current.javaClass.name.substringAfterLast('.') }
            current = current.cause?.takeIf { it !== current }
        }
        return names.joinToString(" < ")
    }

    /**
     * A Media3 player error: [errorCodeName] (`ERROR_CODE_IO_BAD_HTTP_STATUS`, …), [httpStatus] of an HTTP answer, while
     * [ref] played (a channel has no [positionMs]).
     */
    fun playbackError(
        error: Throwable,
        errorCodeName: String,
        httpStatus: Int?,
        ref: PlayableRef?,
        sourceId: String?,
        sessionId: String?,
        positionMs: Long?,
        appVersion: String,
    ): ProblemReport = ProblemReport(
        kind = "playback",
        code = code(errorCodeName),
        itemId = ref?.itemId,
        episodeId = ref?.episodeId,
        sourceId = sourceId,
        sessionId = sessionId,
        positionMs = positionMs?.coerceAtLeast(0),
        httpStatus = httpStatus?.takeIf { it in 100..599 },
        detail = classChain(error).take(MAX_DETAIL_CHARS),
        appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
    )

    /**
     * A resolve request that failed: the server's error code (`no_playable_source`, `http_502`, …) or `network`. Null
     * for a 401: the device was removed, and the report would be refused the same way.
     */
    fun resolveFailure(error: Exception, ref: PlayableRef, sourceId: String?, appVersion: String): ProblemReport? {
        if (error is ApiException && error.status == 401) return null
        val api = error as? ApiException
        return ProblemReport(
            kind = "resolve",
            code = if (api != null) code(api.code) else "network",
            itemId = ref.itemId,
            episodeId = ref.episodeId,
            sourceId = sourceId,
            httpStatus = api?.status?.takeIf { it in 100..599 },
            detail = if (api != null) null else classChain(error).take(MAX_DETAIL_CHARS),
            appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
        )
    }

    /**
     * "Can't play right now" for [ref] after [sourcesTried] sources (a channel has no [positionMs]); [reason]: what
     * ended it when not a player error.
     */
    fun gaveUp(
        ref: PlayableRef,
        sourceId: String?,
        positionMs: Long?,
        sourcesTried: Int,
        appVersion: String,
        reason: String? = null,
    ): ProblemReport = ProblemReport(
        kind = "playback",
        code = "gave_up",
        itemId = ref.itemId,
        episodeId = ref.episodeId,
        sourceId = sourceId,
        positionMs = positionMs?.coerceAtLeast(0),
        detail = listOfNotNull(if (sourcesTried == 1) "tried 1 source" else "tried $sourcesTried sources", reason)
            .joinToString(", ").take(MAX_DETAIL_CHARS),
        appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
    )

    /** The server could not be reached for [durationMs]; sent once it answers again. */
    fun serverUnreachable(durationMs: Long, appVersion: String): ProblemReport = ProblemReport(
        kind = "network",
        code = "server_unreachable",
        detail = "unreachable for ${durationText(durationMs)}",
        appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
    )

    /**
     * A self-update that did not happen: `update_` + [code], the command result's reason (`update_verify`), the
     * install status (`update_failure_storage`) or `update_needs_user_action` (a silent install the system wanted
     * confirmed).
     */
    fun update(code: String, appVersion: String): ProblemReport = ProblemReport(
        kind = "other",
        code = code("update_$code"),
        appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
    )

    /** The report as sent [ageMs] after it happened (clamped to what the server accepts). */
    fun aged(report: ProblemReport, ageMs: Long): ProblemReport = report.copy(ageMs = ageMs.coerceIn(0, MAX_AGE_MS))

    /** `7 min 5 s`, `2 h 3 min`. */
    fun durationText(ms: Long): String {
        val totalSec = ms.coerceAtLeast(0) / 1_000
        val h = totalSec / 3_600
        val min = (totalSec % 3_600) / 60
        val s = totalSec % 60
        return when {
            h > 0 -> "$h h $min min"
            min > 0 -> "$min min $s s"
            else -> "$s s"
        }
    }
}
