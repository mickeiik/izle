package io.github.mickeiik.izle.player

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ProgressReport
import io.github.mickeiik.izle.data.api.ProgressStatus
import io.github.mickeiik.izle.domain.PlaybackPlan
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

/**
 * Delivers progress reports (`POST /tv/progress`) through one ordered queue in [scope], the application scope: a report
 * outlives the screen, and a late heartbeat never overwrites a `finished` or `stopped`. Heartbeats are best effort;
 * final reports are retried a few times, then [onFinalDelivered] refreshes Home, whose tile depends on them. A 400 to
 * an episode's report means a server from before "Listen along": it and every later report go without `playing` and
 * `ageMs`. Other 4xx answers drop the report (an unknown episode or item after a catalog change).
 */
class ProgressReporter(
    scope: CoroutineScope,
    /** Network failures throw [IOException], error answers [ApiException]. */
    private val send: suspend (ApiClient, ProgressReport) -> Unit,
    private val onFinalDelivered: () -> Unit,
    /** Monotonic, in milliseconds: a report's age is computed when it is sent. */
    private val clock: () -> Long,
) {
    private class QueuedReport(val api: ApiClient, val report: ProgressReport, val sampledAt: Long)

    private val reports = Channel<QueuedReport>(Channel.UNLIMITED)
    private var legacyProgress = false

    /** Reports queued or in flight; a new resolve waits for them so `resume` and the cursor are current. */
    private val pendingReports = MutableStateFlow(0)

    init {
        scope.launch {
            for (queued in reports) {
                deliver(queued)
                pendingReports.update { it - 1 }
            }
        }
    }

    /** Queues [report], sampled now, for [api]'s server. */
    fun enqueue(api: ApiClient, report: ProgressReport) {
        pendingReports.update { it + 1 }
        reports.trySend(QueuedReport(api, report, clock()))
    }

    /** Waits until every queued report was delivered or given up, at most [timeoutMs]. */
    suspend fun awaitDelivered(timeoutMs: Long = MAX_WAIT_MS) {
        withTimeoutOrNull(timeoutMs) { pendingReports.first { it <= 0 } }
    }

    private suspend fun deliver(q: QueuedReport) {
        val final = q.report.status.isFinal
        val attempts = if (final) FINAL_REPORT_ATTEMPTS else 1
        var attempt = 0
        while (attempt < attempts) {
            if (attempt > 0) delay(RETRY_STEP_MS * attempt)
            // Retries carry the grown age.
            val report = if (legacyProgress) {
                q.report.copy(playing = null, ageMs = null)
            } else {
                q.report.copy(ageMs = PlaybackPlan.reportAgeMs(q.sampledAt, clock()))
            }
            try {
                send(q.api, report)
                if (final) onFinalDelivered()
                return
            } catch (e: IOException) {
                attempt++
            } catch (e: ApiException) {
                // A second 400 then finds no anchor fields and drops the report. A server that takes channel reports
                // knows them: a 400 there (`has_episodes`) is any other refusal.
                if (e.status == 400 && report.episodeId != null && (report.playing != null || report.ageMs != null)) {
                    legacyProgress = true
                    continue
                }
                if (e.status < 500) return
                attempt++
            }
        }
    }

    companion object {
        /** `stopped` and `finished` are tried this many times, 2, 4 and 6 s apart. */
        const val FINAL_REPORT_ATTEMPTS = 4
        const val RETRY_STEP_MS = 2_000L
        const val MAX_WAIT_MS = 3_000L
    }
}
