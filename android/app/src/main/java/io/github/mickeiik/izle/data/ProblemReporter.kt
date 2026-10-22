package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ProblemReport
import io.github.mickeiik.izle.data.api.orNullOnFailure
import io.github.mickeiik.izle.domain.Problems
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Sends problem reports (`POST /tv/problems`) for the owner's admin page. Best effort: one attempt in the background,
 * every failure ignored (an old server's 400/404, rate limiting, no server), nothing waits for it.
 */
class ProblemReporter(
    private val scope: CoroutineScope,
    private val currentApi: () -> ApiClient?,
    /** Monotonic, in milliseconds: reports carry how long ago the problem happened. */
    private val clock: () -> Long,
) {
    fun now(): Long = clock()

    fun send(report: ProblemReport?, happenedAt: Long = clock(), api: ApiClient? = currentApi()) {
        if (report == null || api == null) return
        scope.launch {
            orNullOnFailure { api.reportProblem(Problems.aged(report, clock() - happenedAt)) }
        }
    }
}
