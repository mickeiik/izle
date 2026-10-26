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
 * once per page) until one is [LinkFinderState.found], which stays the found link: the page's first playlist (the
 * master playlist, which the player loads first), until [clear] or a pasted link. Found links live here, in memory,
 * only.
 */
class LinkFinder(
    private val confirm: suspend (String, Map<String, String>) -> FoundLink?,
    private val scope: CoroutineScope,
) {
    private val lock = Any()
    private val _state = MutableStateFlow(LinkFinderState())
    val state: StateFlow<LinkFinderState> = _state.asStateFlow()

    /** Checks under one parent job, dropped together: the page's (replaced on navigation) or the pasted links'. */
    private inner class Checks {
        var job: Job = SupervisorJob(scope.coroutineContext[Job])
        var inFlight = 0

        fun drop() {
            job.cancel()
            job = SupervisorJob(scope.coroutineContext[Job])
            inFlight = 0
        }
    }

    // Guarded by lock: the URLs offered on this page, and the checks in flight.
    private val seen = HashSet<String>()
    private val pageChecks = Checks()
    private val pasteChecks = Checks()

    /**
     * A request the page made. Callable from any thread (the WebView calls it off the main thread). Non-candidates
     * are ignored; while a link is found, every candidate is skipped; a candidate is confirmed once per page, with the
     * page's `Referer` and `Origin` and the cookies for it. The request's `Referer` and `Origin` are taken from
     * [pageUrl] (the page's current URL) when it lacks them.
     */
    fun offer(url: String, requestHeaders: Map<String, String>, cookie: String?, pageUrl: String? = null) {
        if (!isCandidate(url)) return
        synchronized(lock) {
            if (_state.value.found != null) {
                FinderLog.d("candidate skipped: a link is already found")
                return
            }
            if (!seen.add(url)) {
                FinderLog.d("candidate skipped: seen before")
                return
            }
        }
        val headers = headersFor(requestHeaders, cookie, pageUrl)
        val fallback = headers.size > headersFor(requestHeaders, cookie).size
        FinderLog.d(
            "candidate offered (referer: ${FinderLog.yesNo("Referer" in headers)}, origin: ${FinderLog.yesNo("Origin" in headers)}, " +
                "cookie: ${FinderLog.yesNo("Cookie" in headers)}, fallback: ${FinderLog.yesNo(fallback)})",
        )
        // The first confirmed playlist is kept: a later one confirmed meanwhile does not replace it.
        check(pageChecks, url, headers) { found, s -> if (found != null && s.found == null) s.copy(found = found) else s }
    }

    /** A link pasted by the owner: any `http(s)` URL (it may lack `m3u8`), confirmed without headers. */
    fun paste(text: String) {
        val url = text.trim()
        if (!isHttpUrl(url)) {
            update { it.copy(pasteError = true) }
            return
        }
        update { it.copy(pasteError = false) }
        check(pasteChecks, url, emptyMap()) { found, s ->
            if (found != null) s.copy(found = found, pasteError = false) else s.copy(pasteError = true)
        }
    }

    /** The paste error is no longer shown (the paste field was hidden). */
    fun dismissPasteError() = update { it.copy(pasteError = false) }

    /**
     * The browser moved to another page: the URLs seen and the page's checks in flight are forgotten (their results
     * are dropped), so a URL checked on an earlier visit is checked again. The found link stays.
     */
    fun pageNavigated() = synchronized(lock) {
        pageChecks.drop()
        seen.clear()
        _state.value = _state.value.copy(checking = pasteChecks.inFlight > 0)
    }

    /** Forgets everything: the found link, the URLs seen, the checks in flight (their results are dropped). */
    fun clear() = synchronized(lock) {
        pageChecks.drop()
        pasteChecks.drop()
        seen.clear()
        _state.value = LinkFinderState()
    }

    private fun check(checks: Checks, url: String, headers: Map<String, String>, apply: (FoundLink?, LinkFinderState) -> LinkFinderState) {
        val parent = synchronized(lock) {
            checks.inFlight++
            _state.value = _state.value.copy(checking = true)
            checks.job
        }
        scope.launch(parent) {
            var found: FoundLink? = null
            try {
                found = confirm(url, headers)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Not a playlist, whatever went wrong.
                FinderLog.d("confirm: failed (${e.javaClass.simpleName})")
            } finally {
                synchronized(lock) {
                    // A check from before a clear() or a navigation belongs to a forgotten page: its result is dropped.
                    if (parent === checks.job) {
                        checks.inFlight--
                        _state.value = apply(found, _state.value).copy(checking = pageChecks.inFlight + pasteChecks.inFlight > 0)
                    } else {
                        FinderLog.d("check: result dropped (the finder was cleared or the page changed)")
                    }
                }
            }
        }
    }

    private fun update(change: (LinkFinderState) -> LinkFinderState) = synchronized(lock) { _state.value = change(_state.value) }
}
