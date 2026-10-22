package io.github.mickeiik.izle.data

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.player.ProgressReporter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Tells the server what became of each owner command (`POST /tv/commands/:id/result`) from [scope], the application
 * scope, so a result outlives the screen. The acknowledgement stays separate and immediate (see [ServerRepository]):
 * a slow `play` is never replayed. Only the first result per command counts. Each is tried like a final progress
 * report, on network failures and 5xx; any 4xx ends it (`404 unknown_command`, `409 already_reported`, …). Main thread.
 */
class CommandResultReporter(
    private val scope: CoroutineScope,
    /** Network failures throw [IOException], error answers [ApiException]. */
    private val send: suspend (ApiClient, Long, CommandResult) -> Unit,
) {
    /** Per server connection: command ids restart on another server. */
    private val answered = ArrayDeque<Pair<ApiClient, Long>>()

    fun report(api: ApiClient, commandId: Long, result: CommandResult) {
        if (!claim(api, commandId)) return
        scope.launch { deliver(api, commandId, result, ProgressReporter.FINAL_REPORT_ATTEMPTS) { ProgressReporter.RETRY_STEP_MS * it } }
    }

    /**
     * Sends [result] now and waits for it, for a result that has to arrive before the process may die (a self-update
     * installing). False when the server did not take it or the command was already answered; only a result the server
     * took claims the command, so after a failed one a later [report] may still go out.
     */
    suspend fun reportNow(api: ApiClient, commandId: Long, result: CommandResult, attempts: Int = 2): Boolean {
        if ((api to commandId) in answered) return false
        if (!deliver(api, commandId, result, attempts) { ProgressReporter.RETRY_STEP_MS }) return false
        // (A report() meanwhile may have claimed it already: the server keeps the first to arrive.)
        claim(api, commandId)
        return true
    }

    private fun claim(api: ApiClient, commandId: Long): Boolean {
        val key = api to commandId
        if (key in answered) return false
        answered.addLast(key)
        while (answered.size > REMEMBERED) answered.removeFirst()
        return true
    }

    private suspend fun deliver(api: ApiClient, id: Long, result: CommandResult, attempts: Int, delayMs: (Int) -> Long): Boolean {
        for (attempt in 0 until attempts) {
            if (attempt > 0) delay(delayMs(attempt))
            try {
                send(api, id, result)
                return true
            } catch (e: IOException) {
                // retried
            } catch (e: ApiException) {
                if (e.status < 500) return false
            }
        }
        return false
    }

    private companion object {
        /** As many as the repository remembers to drop replayed commands. */
        const val REMEMBERED = 64
    }
}
