package io.github.mickeiik.izle.player

import okhttp3.Headers.Companion.toHeaders
import okhttp3.OkHttpClient

/**
 * [this] client with [headers] added to every request whose host is [host] (case-insensitive), and to no other: a
 * redirect to another host gets none of them, as a browser never sends a host's cookie elsewhere. A network
 * interceptor, so it sees every hop, redirects included; only the host counts (not the scheme or the port), as for
 * cookies, so an `http` to `https` upgrade on the same host keeps them. The returned client shares this one's
 * connection pool and dispatcher. Throws [IllegalArgumentException], here and not inside a call, for a header OkHttp
 * cannot send. Never logs: the header values are the owner's.
 */
fun OkHttpClient.withHostBoundHeaders(host: String, headers: Map<String, String>): OkHttpClient {
    val bound = headers.toHeaders()
    return newBuilder().addNetworkInterceptor { chain ->
        val request = chain.request()
        if (bound.size == 0 || !request.url.host.equals(host, ignoreCase = true)) {
            chain.proceed(request)
        } else {
            chain.proceed(request.newBuilder().apply { bound.forEach { (name, value) -> header(name, value) } }.build())
        }
    }.build()
}
