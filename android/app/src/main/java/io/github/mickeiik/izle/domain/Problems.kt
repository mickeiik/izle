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
     * A Media3 player error. [errorCodeName] is `PlaybackException.errorCodeName` (`ERROR_CODE_IO_BAD_HTTP_STATUS`, …),
     * [httpStatus] the upstream status when the error was an HTTP answer.
     */
    fun playbackError(
        error: Throwable,
        errorCodeName: String,
        httpStatus: Int?,
        episodeId: String?,
        sourceId: String?,
        sessionId: String?,
        positionMs: Long?,
        appVersion: String,
    ): ProblemReport = ProblemReport(
        kind = "playback",
        code = code(errorCodeName),
        episodeId = episodeId,
        sourceId = sourceId,
        sessionId = sessionId,
        positionMs = positionMs?.coerceAtLeast(0),
        httpStatus = httpStatus?.takeIf { it in 100..599 },
        detail = classChain(error).take(MAX_DETAIL_CHARS),
        appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
    )

    /**
     * A resolve request that failed: the server's error code (`no_playable_source`, `not_allowed`, `http_502`, …) or
     * `network`. Null for a 401: the device was removed, and the report would be refused the same way.
     */
    fun resolveFailure(error: Exception, episodeId: String, sourceId: String?, appVersion: String): ProblemReport? {
        val (code, status, detail) = when (error) {
            is ApiException -> {
                if (error.status == 401) return null
                Triple(code(error.code), error.status.takeIf { it in 100..599 }, null)
            }
            else -> Triple("network", null, classChain(error).take(MAX_DETAIL_CHARS))
        }
        return ProblemReport(
            kind = "resolve",
            code = code,
            episodeId = episodeId,
            sourceId = sourceId,
            httpStatus = status,
            detail = detail,
            appVersion = appVersion.take(MAX_APP_VERSION_CHARS),
        )
    }

    /**
     * The viewer got "Can't play right now" after [sourcesTried] sources failed in the player; [reason] says what
     * ended it when that was not a player error (`then resolve failed: no_playable_source`). Never a URL.
     */
    fun gaveUp(
        episodeId: String,
        sourceId: String?,
        positionMs: Long?,
        sourcesTried: Int,
        appVersion: String,
        reason: String? = null,
    ): ProblemReport = ProblemReport(
        kind = "playback",
        code = "gave_up",
        episodeId = episodeId,
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
