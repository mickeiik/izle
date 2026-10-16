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
 * Tells the server what became of each owner command (`POST /tv/commands/:id/result`), from [scope], the application
 * scope, so a result outlives the screen. The acknowledgement stays separate and immediate (see [ServerRepository]):
 * a slow `play` is never replayed, and an owner or agent learns from the result whether it worked.
 *
 * Only the first result per command counts; later ones for the same id are dropped here. Each is tried like a final
 * progress report: 4 attempts, 2, 4 and 6 s apart, on network failures and 5xx. Any 4xx ends it: `404 unknown_command`
 * from a server that predates results (or another TV's id), `409 already_reported`, anything else the server refuses.
 * Main thread only.
 */
class CommandResultReporter(
    private val scope: CoroutineScope,
    /** Sends one result; network failures throw [IOException], error answers [ApiException]. */
    private val send: suspend (ApiClient, Long, CommandResult) -> Unit,
) {
    /** Recent commands already answered, per server connection: command ids restart on another server. */
    private val answered = ArrayDeque<Pair<ApiClient, Long>>()

    fun report(api: ApiClient, commandId: Long, result: CommandResult) {
        if (!claim(api, commandId)) return
        scope.launch { deliver(api, commandId, result) }
    }

    /**
     * Sends [result] now and waits for it: [attempts] tries, [ProgressReporter.RETRY_STEP_MS] apart. For a result
     * that has to arrive before the process may die (a self-update installing). True when the server took it; false
     * when it did not, or the command was already answered.
     */
    suspend fun reportNow(api: ApiClient, commandId: Long, result: CommandResult, attempts: Int = 2): Boolean {
        if (!claim(api, commandId)) return false
        for (attempt in 0 until attempts) {
            if (attempt > 0) delay(ProgressReporter.RETRY_STEP_MS)
            try {
                send(api, commandId, result)
                return true
            } catch (e: IOException) {
                // retried
            } catch (e: ApiException) {
                if (e.status < 500) return false
            }
        }
        return false
    }

    /** The first result for this command claims it; false for any later one. */
    private fun claim(api: ApiClient, commandId: Long): Boolean {
        val key = api to commandId
        if (key in answered) return false
        answered.addLast(key)
        while (answered.size > REMEMBERED) answered.removeFirst()
        return true
    }

    private suspend fun deliver(api: ApiClient, commandId: Long, result: CommandResult) {
        for (attempt in 0 until ProgressReporter.FINAL_REPORT_ATTEMPTS) {
            if (attempt > 0) delay(ProgressReporter.RETRY_STEP_MS * attempt)
            try {
                send(api, commandId, result)
                return
            } catch (e: IOException) {
                // retried
            } catch (e: ApiException) {
                if (e.status < 500) return
            }
        }
    }

    private companion object {
        /** As many as the repository remembers to drop replayed commands. */
        const val REMEMBERED = 64
    }
}
