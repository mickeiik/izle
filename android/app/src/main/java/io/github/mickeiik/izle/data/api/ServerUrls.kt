package io.github.mickeiik.izle.data.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerUrls {
    /** What the owner typed, `http://` by default, without query or fragment and with a path ending in `/`. */
    fun parse(input: String): HttpUrl? {
        val text = input.trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        val withScheme = if ("://" in text) text else "http://$text"
        val url = withScheme.toHttpUrlOrNull() ?: return null
        if (url.host.isEmpty()) return null
        val builder = url.newBuilder().query(null).fragment(null).username("").password("")
        if (!url.encodedPath.endsWith("/")) builder.encodedPath(url.encodedPath + "/")
        return builder.build()
    }

    /** Server-relative references (`/assets/…`) are resolved below the base path (a reverse proxy at `/izle/`). */
    fun resolve(base: HttpUrl, reference: String): HttpUrl? {
        val ref = reference.trim()
        if (ref.isEmpty()) return null
        if (ref.startsWith("/") && !ref.startsWith("//")) return base.resolve(ref.trimStart('/'))
        return base.resolve(ref)
    }

    /** For screens: scheme, host, port (unless the default) and path, without the trailing slash. */
    fun display(url: HttpUrl): String {
        val defaultPort = HttpUrl.defaultPort(url.scheme)
        val port = if (url.port == defaultPort) "" else ":${url.port}"
        val path = url.encodedPath.trimEnd('/')
        return "${url.scheme}://${url.host}$port$path"
    }

    /** As the owner would type it on a phone (the server redirects to the trailing slash). */
    fun adminPage(url: HttpUrl): String = "${display(url)}/admin"
}
