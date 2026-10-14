package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ProblemReport
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.Problems
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Sends problem reports (`POST /tv/problems`) for the owner's admin page. Best effort by design: one attempt, in
 * the background, every failure ignored — a server that predates the route (400/404), rate limiting (429) and an
 * unreachable server included. Nothing waits for it and nothing is retried.
 */
class ProblemReporter(
    private val scope: CoroutineScope,
    private val currentApi: () -> ApiClient?,
    /** A monotonic clock in milliseconds; reports carry how long ago the problem happened. */
    private val clock: () -> Long,
) {
    fun now(): Long = clock()

    /** Sends [report] about something that happened at [happenedAt] (by [clock]) to [api], the current server by default. */
    fun send(report: ProblemReport?, happenedAt: Long = clock(), api: ApiClient? = currentApi()) {
        if (report == null || api == null) return
        scope.launch {
            orNullOnFailure { api.reportProblem(Problems.aged(report, clock() - happenedAt)) } // best effort
        }
    }
}
