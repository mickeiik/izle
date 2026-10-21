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
 * Delivers the player's progress reports (`POST /tv/progress`), an episode's or a channel's, through one ordered queue
 * in [scope], the application scope: a report outlives the screen, and a late heartbeat can never overwrite a
 * `finished` or `stopped`. Heartbeats are best effort (the next one carries the position again); `stopped` and
 * `finished` are the last word on an episode (and end a channel's viewing), so they are retried a few times and then
 * [onFinalDelivered] refreshes Home, whose tile depends on them. A 400 to an episode's report means a server from
 * before "Listen along" rejecting the anchor fields (`playing`, `ageMs`): the report is sent again without them, and
 * so is every later one. Other 4xx answers drop the report (an unknown episode or item after a catalog change).
 */
class ProgressReporter(
    scope: CoroutineScope,
    /** Sends one report; network failures throw [IOException], error answers [ApiException]. */
    private val send: suspend (ApiClient, ProgressReport) -> Unit,
    private val onFinalDelivered: () -> Unit,
    /** A monotonic clock in milliseconds (elapsedRealtime): a report's age is computed when it is sent. */
    private val clock: () -> Long,
) {
    /** A report with the moment its position was sampled, so its age is known when it is finally sent. */
    private class QueuedReport(val api: ApiClient, val report: ProgressReport, val sampledAt: Long)

    private val reports = Channel<QueuedReport>(Channel.UNLIMITED)

    /** The server rejected the anchor fields (it predates "Listen along"): send reports without them. */
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

    /** Queues a report of [positionMs] in [episodeId] (sampled now, never negative) for [api]'s server. */
    fun report(api: ApiClient, sessionId: String?, episodeId: String, status: ProgressStatus, positionMs: Long, durationMs: Long?, playing: Boolean) =
        enqueue(api, ProgressReport.episode(sessionId, episodeId, status, positionMs, durationMs, playing))

    /** Queues a report of the channel [itemId] (sampled now): `playing` or `stopped`, without a position. */
    fun reportChannel(api: ApiClient, sessionId: String?, itemId: String, status: ProgressStatus, playing: Boolean) =
        enqueue(api, ProgressReport.channel(sessionId, itemId, status, playing))

    private fun enqueue(api: ApiClient, report: ProgressReport) {
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
            val report = stamp(q)
            try {
                send(q.api, report)
                if (final) onFinalDelivered()
                return
            } catch (e: IOException) {
                attempt++ // retried for final reports
            } catch (e: ApiException) {
                if (e.status == 400 && report.episodeId != null && (report.playing != null || report.ageMs != null)) {
                    // A server from before "Listen along" rejects the anchor fields: resend without them, from now on
                    // (a second 400 then finds none and drops the report). A server that takes channel reports knows
                    // them: a 400 there (`has_episodes`) is any other refusal.
                    legacyProgress = true
                    continue
                }
                if (e.status < 500) return // unknown episode after a catalog change: nothing to save
                attempt++
            }
        }
    }

    /** The report as sent now: with the sample's age at send time (retries carry the grown age), or without the anchor fields for an old server. */
    private fun stamp(q: QueuedReport): ProgressReport =
        if (legacyProgress) q.report.copy(playing = null, ageMs = null)
        else q.report.copy(ageMs = PlaybackPlan.reportAgeMs(q.sampledAt, clock()))

    companion object {
        /** `stopped` and `finished` are tried this many times, 2, 4 and 6 s apart. */
        const val FINAL_REPORT_ATTEMPTS = 4
        const val RETRY_STEP_MS = 2_000L

        /** How long a new resolve waits for queued reports. */
        const val MAX_WAIT_MS = 3_000L
    }
}
