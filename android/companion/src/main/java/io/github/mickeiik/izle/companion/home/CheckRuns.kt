package io.github.mickeiik.izle.companion.home

import android.content.res.Resources
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CheckRun
import io.github.mickeiik.izle.data.api.orNullOnFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// A batch check (a TV's Home, or one show) as the Home tab follows it: started here or found running, followed with
// the run's long-poll until it ends, then its result kept for a few seconds. One runs at a time on the server.

/**
 * The run the Home tab shows in its strip ([run] null: none). Starting while another run goes follows that one and
 * says so ([onNotice]); a run that ends stays [RESULT_MS] (or until [dismiss]). Home's chips are not reloaded here: the
 * tab reloads on `check.finished` like on every other event.
 */
class CheckRuns(private val api: ApiClient, private val scope: CoroutineScope, private val onNotice: (HomeNotice) -> Unit) {
    private val _run = MutableStateFlow<CheckRun?>(null)
    val run: StateFlow<CheckRun?> = _run.asStateFlow()

    private var job: Job? = null

    /** Checks the Home of [tvId] (`quick` or `full`). */
    fun startHome(tvId: String, mode: String) = start { api.startHomeCheck(tvId, mode) }

    /** Checks every episode of [itemId] that may play (or the channel). */
    fun startShow(itemId: String) = start { api.startShowCheck(itemId) }

    private fun start(call: suspend () -> CheckRun) {
        scope.launch {
            val run = try {
                call()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                val other = e.runId?.takeIf { e.code == "check_running" }?.let { id -> orNullOnFailure { api.checkRun(id) } }
                if (other == null) return@launch onNotice(HomeNotice.Failed(HomeViewModel.errorOf(e)))
                onNotice(HomeNotice.CheckRunning(other))
                other
            } catch (e: Exception) {
                return@launch onNotice(HomeNotice.Failed(HomeViewModel.errorOf(e)))
            }
            follow(run)
        }
    }

    /** Follows a run already going when the tab opens, when [mine] says it is about this Home. */
    suspend fun resume(mine: (CheckRun) -> Boolean) {
        val current = orNullOnFailure { api.currentCheck() } ?: return
        if (current.running && mine(current) && _run.value?.id != current.id) follow(current)
    }

    /** Stops the run shown; the follow sees it end. */
    fun stop() {
        val r = _run.value?.takeIf { it.running } ?: return
        scope.launch {
            try {
                show(api.cancelCheck(r.id))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onNotice(HomeNotice.Failed(HomeViewModel.errorOf(e)))
            }
        }
    }

    /** Hides the result of a run that ended. */
    fun dismiss() {
        if (_run.value?.running == true) return
        job?.cancel()
        _run.value = null
    }

    private fun follow(first: CheckRun) {
        job?.cancel()
        _run.value = first
        job = scope.launch {
            var run = first
            while (run.running) {
                run = try {
                    api.checkRun(run.id, seq = run.seq, waitMs = WAIT_MS)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    // Only the last run is kept: one gone (a restart, a newer run) has nothing more to show.
                    if (e.code == "unknown_check") return@launch _run.update { if (it?.id == first.id) null else it }
                    delay(RETRY_MS)
                    continue
                } catch (e: Exception) {
                    delay(RETRY_MS)
                    continue
                }
                show(run)
            }
            delay(RESULT_MS)
            _run.update { if (it?.id == first.id) null else it }
        }
    }

    /** A newer state of the run shown (Stop's answer and the long-poll may cross). */
    private fun show(run: CheckRun) = _run.update { if (it == null || it.id != run.id || run.seq >= it.seq) run else it }

    companion object {
        const val WAIT_MS = 25_000
        const val RETRY_MS = 5_000L
        const val RESULT_MS = 8_000L
    }
}

/** What a run checks: the show's title, or "Home of Salon, quick" / ", full" (lib.js `runTitle`). */
fun runTitle(res: Resources, run: CheckRun): String = when {
    run.target.deviceId == null -> run.title
    run.target.mode == CheckRun.MODE_QUICK -> res.getString(R.string.home_check_of_home_quick, run.title)
    else -> res.getString(R.string.home_check_of_home_full, run.title)
}

/**
 * "12 of 40 checked · 1 failing · 2 with warnings"; "Stopped: 12 of 40 checked …"; "Done: 40 checked · all work" (or
 * what failed). Skipped shows are counted last (lib.js `runProgressText`), unless [countSkipped] is false (the
 * [skippedText] sentence names them).
 */
fun runProgressText(res: Resources, run: CheckRun, countSkipped: Boolean = true): String {
    val found = listOfNotNull(
        run.failed.takeIf { it > 0 }?.let { res.getString(R.string.home_check_failing, it) },
        run.warned.takeIf { it > 0 }?.let { res.getString(R.string.home_check_warned, it) },
    )
    val skipped = listOfNotNull(run.skipped.size.takeIf { countSkipped && it > 0 }?.let { res.getString(R.string.home_check_skipped, it) })
    val parts = when (run.state) {
        CheckRun.STATE_DONE -> listOf(res.getString(R.string.home_check_done, run.done)) + found.ifEmpty { listOf(res.getString(R.string.home_check_all_work)) }
        CheckRun.STATE_CANCELLED -> listOf(res.getString(R.string.home_check_stopped, run.done, run.total)) + found
        else -> listOf(res.getString(R.string.home_check_progress, run.done, run.total)) + found
    }
    return (parts + skipped).joinToString(" · ")
}

/** "Skipped: Sintel (missing from the catalog), Tears (not playable)."; null when none (lib.js `skippedText`). */
fun skippedText(res: Resources, run: CheckRun): String? {
    if (run.skipped.isEmpty()) return null
    val list = run.skipped.joinToString(", ") {
        val name = it.title ?: it.itemId
        res.getString(if (it.reason == "missing") R.string.home_check_skipped_missing else R.string.home_check_skipped_unplayable, name)
    }
    return res.getString(R.string.home_check_skipped_list, list)
}

/** How a run's result reads at a glance: Fails when one failed, Warns with warnings, Works when all did, else neutral (stopped, running). */
fun runVerdict(run: CheckRun): Verdict = when {
    run.failed > 0 -> Verdict.Fails
    run.warned > 0 -> Verdict.Warns
    run.state == CheckRun.STATE_DONE -> Verdict.Works
    else -> Verdict.NotChecked
}
