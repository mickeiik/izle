package io.github.mickeiik.izle.companion.finder

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the link finder shows: a confirmed link (never its URL), a check in progress, a pasted link that failed. */
data class LinkFinderState(val found: FoundLink? = null, val checking: Boolean = false, val pasteError: Boolean = false)

/**
 * The link finder's state: the page's requests are offered, candidates are confirmed by [confirm] (each distinct URL
 * once), and the last confirmed link is [LinkFinderState.found]. Found links live here, in memory, only.
 */
class LinkFinder(
    private val confirm: suspend (String, Map<String, String>) -> FoundLink?,
    private val scope: CoroutineScope,
) {
    private val lock = Any()
    private val _state = MutableStateFlow(LinkFinderState())
    val state: StateFlow<LinkFinderState> = _state.asStateFlow()

    // Guarded by lock: the URLs already offered, the checks in flight, and their parent job (replaced by clear()).
    private val seen = HashSet<String>()
    private var inFlight = 0
    private var checks: Job = SupervisorJob(scope.coroutineContext[Job])

    /**
     * A request the page made. Callable from any thread (the WebView calls it off the main thread). Non-candidates
     * are ignored; a candidate is confirmed once, with the page's `Referer` and `Origin` and the cookies for it.
     */
    fun offer(url: String, requestHeaders: Map<String, String>, cookie: String?) {
        if (!isCandidate(url)) return
        synchronized(lock) { if (!seen.add(url)) return }
        check(url, headersFor(requestHeaders, cookie)) { found, s -> if (found != null) s.copy(found = found) else s }
    }

    /** A link pasted by the owner: any `http(s)` URL (it may lack `m3u8`), confirmed without headers. */
    fun paste(text: String) {
        val url = text.trim()
        if (!isHttpUrl(url)) {
            update { it.copy(pasteError = true) }
            return
        }
        update { it.copy(pasteError = false) }
        check(url, emptyMap()) { found, s ->
            if (found != null) s.copy(found = found, pasteError = false) else s.copy(pasteError = true)
        }
    }

    /** The paste error is no longer shown (the paste field was hidden). */
    fun dismissPasteError() = update { it.copy(pasteError = false) }

    /** Forgets everything: the found link, the URLs seen, the checks in flight (their results are dropped). */
    fun clear() = synchronized(lock) {
        checks.cancel()
        checks = SupervisorJob(scope.coroutineContext[Job])
        seen.clear()
        inFlight = 0
        _state.value = LinkFinderState()
    }

    private fun check(url: String, headers: Map<String, String>, apply: (FoundLink?, LinkFinderState) -> LinkFinderState) {
        val parent = synchronized(lock) {
            inFlight++
            _state.value = _state.value.copy(checking = true)
            checks
        }
        scope.launch(parent) {
            var found: FoundLink? = null
            try {
                found = confirm(url, headers)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Not a playlist, whatever went wrong.
            } finally {
                synchronized(lock) {
                    // A check from before a clear() belongs to the forgotten page: its result is dropped.
                    if (parent === checks) {
                        inFlight--
                        _state.value = apply(found, _state.value).copy(checking = inFlight > 0)
                    }
                }
            }
        }
    }

    private fun update(change: (LinkFinderState) -> LinkFinderState) = synchronized(lock) { _state.value = change(_state.value) }
}
