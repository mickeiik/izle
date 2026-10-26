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
 * this fetch is what tells a playlist from anything else. Never logs: the URL and the header values are the owner's.
 */
class LinkConfirmer(private val http: OkHttpClient) {
    suspend fun confirm(url: String, headers: Map<String, String>): FoundLink? {
        val httpUrl = url.toHttpUrlOrNull() ?: return null
        val client = try {
            http.withHostBoundHeaders(httpUrl.host, headers)
        } catch (_: IllegalArgumentException) {
            return null // a header OkHttp refuses to send
        }
        val request = Request.Builder().url(httpUrl).get().build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = continuation.resume(null)

                override fun onResponse(call: Call, response: Response) {
                    val playlist = try {
                        response.use { it.isSuccessful && looksLikePlaylist(readStart(it)) }
                    } catch (_: IOException) {
                        false
                    }
                    continuation.resume(if (playlist) FoundLink(url, headers) else null)
                }
            })
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
