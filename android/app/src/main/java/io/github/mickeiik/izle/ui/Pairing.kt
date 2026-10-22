package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.PairStart
import io.github.mickeiik.izle.data.api.PairWait
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.IOException

enum class PairingProblem { Unreachable, RateLimited }

/** `adminUrl` is the admin page's address, shown so the owner knows what to open on the phone. */
data class PairingUi(val adminUrl: String = "", val code: String? = null, val problem: PairingProblem? = null)

/** The two pairing calls. Network failures throw [IOException], error answers [ApiException]. */
interface PairingApi {
    suspend fun start(): PairStart

    /** Long-polls for the owner's approval; an expired code (410 included) answers `expired`. */
    suspend fun wait(code: String, pairToken: String): PairWait
}

fun ApiClient.pairingApi(): PairingApi = object : PairingApi {
    override suspend fun start() = pairStart()

    override suspend fun wait(code: String, pairToken: String) = pairWait(code, pairToken)
}

/**
 * Shows a code and long-polls for the owner's approval. A refused start (429 in practice) waits `Retry-After` (5–600 s,
 * 30 s without one), an unreachable server is tried again every 10 s and a lost long poll after 5 s with the same
 * code; an unknown code (404: the server restarted), an expired one or an unusable answer gets a new code at once.
 */
object PairingLoop {
    const val UNREACHABLE_RETRY_MS = 10_000L
    const val WAIT_RETRY_MS = 5_000L
    const val RETRY_AFTER_DEFAULT_SEC = 30L
    val RETRY_AFTER_RANGE_SEC = 5L..600L

    /** Runs until the owner approves; the token comes only once, so [onApproved] runs to its end even if cancelled. */
    suspend fun run(api: PairingApi, ui: MutableStateFlow<PairingUi>, onApproved: suspend (deviceId: String, deviceToken: String) -> Unit) {
        while (currentCoroutineContext().isActive) {
            val start = try {
                api.start()
            } catch (e: ApiException) {
                ui.update { it.copy(code = null, problem = PairingProblem.RateLimited) }
                delay((e.retryAfterSec ?: RETRY_AFTER_DEFAULT_SEC).coerceIn(RETRY_AFTER_RANGE_SEC) * 1_000)
                continue
            } catch (e: IOException) {
                ui.update { it.copy(code = null, problem = PairingProblem.Unreachable) }
                delay(UNREACHABLE_RETRY_MS)
                continue
            }
            ui.update { it.copy(code = start.code, problem = null) }
            while (currentCoroutineContext().isActive) {
                val wait = try {
                    api.wait(start.code, start.pairToken)
                } catch (e: IOException) {
                    ui.update { it.copy(problem = PairingProblem.Unreachable) }
                    delay(WAIT_RETRY_MS)
                    continue
                } catch (e: ApiException) {
                    break // unknown code (server restarted): new code
                }
                ui.update { it.copy(problem = null) }
                if (wait.status == "approved" && wait.deviceId != null && wait.deviceToken != null) {
                    withContext(NonCancellable) { onApproved(wait.deviceId, wait.deviceToken) }
                    return
                }
                if (wait.status != "pending") break
            }
        }
    }
}
