package io.github.mickeiik.izle.companion.finder

import io.github.mickeiik.izle.player.withHostBoundHeaders
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import kotlin.coroutines.resume

/**
 * Confirms a candidate link from this phone (same device, same address as the page): one `GET` with exactly the given
 * headers (to the link's host only, never to a redirect's other host), the start of the body read (at most
 * [MAX_BYTES]), a playlist when the answer is 2xx and starts with `#EXTM3U`. A WebView never sees response headers, so
 * this fetch is what tells a playlist from anything else. Redirects are followed (the client's policy); each one is
 * reported in the debug diagnostics ([FinderLog]) as `http <status>`, with the hosts. The URL and the header values
 * are the owner's: never logged.
 */
class LinkConfirmer(private val http: OkHttpClient) {
    suspend fun confirm(url: String, headers: Map<String, String>): FoundLink? {
        val httpUrl = url.toHttpUrlOrNull() ?: run {
            FinderLog.d("confirm: failed (not an http(s) URL)")
            return null
        }
        val host = httpUrl.host
        val client = try {
            http.withHostBoundHeaders(host, headers)
        } catch (e: IllegalArgumentException) {
            FinderLog.d("confirm: failed (${e.javaClass.simpleName}), host $host")
            return null // a header OkHttp refuses to send
        }
        val request = Request.Builder().url(httpUrl).get().build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (!call.isCanceled()) FinderLog.d("confirm: failed (${e.javaClass.simpleName}), host $host")
                    continuation.resume(null)
                }

                override fun onResponse(call: Call, response: Response) {
                    val playlist = try {
                        response.use { checkResponse(it) }
                    } catch (e: IOException) {
                        FinderLog.d("confirm: failed (${e.javaClass.simpleName}), host ${response.request.url.host}")
                        false
                    }
                    continuation.resume(if (playlist) FoundLink(url, headers) else null)
                }
            })
        }
    }

    /** The answer is a playlist; each step is logged: the redirects followed, then the outcome. */
    private fun checkResponse(response: Response): Boolean {
        logRedirects(response)
        val host = response.request.url.host
        if (!response.isSuccessful) {
            FinderLog.d("confirm: http ${response.code}, host $host")
            return false
        }
        if (!looksLikePlaylist(readStart(response))) {
            val type = response.body.contentType()?.let { "${it.type}/${it.subtype}" } ?: "none"
            FinderLog.d("confirm: not a playlist (content-type $type), host $host")
            return false
        }
        FinderLog.d("confirm: ok, host $host")
        return true
    }

    /** The redirects that led to [response], oldest first: their status and hosts, never their URLs. */
    private fun logRedirects(response: Response) {
        val chain = generateSequence(response) { it.priorResponse }.toList().asReversed()
        for ((prior, next) in chain.zipWithNext()) {
            FinderLog.d("confirm: http ${prior.code} (redirect), host ${prior.request.url.host} to ${next.request.url.host}")
        }
    }

    private fun readStart(response: Response): ByteArray {
        val source = response.body.source()
        val buffer = Buffer()
        while (buffer.size < MAX_BYTES) {
            if (source.read(buffer, MAX_BYTES - buffer.size) == -1L) break
        }
        return buffer.readByteArray()
    }

    companion object {
        /** The most of a body read: plenty for `#EXTM3U` after a BOM and whitespace, little of a large file. */
        const val MAX_BYTES = 16L * 1024
    }
}
