package io.github.mickeiik.izle.data.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerUrls {
    /**
     * Turns what the owner typed into a server base URL: `http://` is assumed when no scheme is given, query and
     * fragment are dropped, and the path always ends with `/` so the server can live under a path prefix.
     */
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

    /**
     * Resolves a URL the server handed out. Server-relative references (`/assets/…`, `/p/…`) are resolved below
     * the base URL's path, so a server behind a reverse proxy at `https://host/izle/` keeps working; absolute URLs
     * are returned as they are.
     */
    fun resolve(base: HttpUrl, reference: String): HttpUrl? {
        val ref = reference.trim()
        if (ref.isEmpty()) return null
        if (ref.startsWith("/") && !ref.startsWith("//")) return base.resolve(ref.trimStart('/'))
        return base.resolve(ref)
    }

    /** A short form for screens: scheme, host, port (unless the default) and path, without the trailing slash. */
    fun display(url: HttpUrl): String {
        val defaultPort = HttpUrl.defaultPort(url.scheme)
        val port = if (url.port == defaultPort) "" else ":${url.port}"
        val path = url.encodedPath.trimEnd('/')
        return "${url.scheme}://${url.host}$port$path"
    }

    /** The server's admin page, as the owner would type it on a phone (the server redirects to the trailing slash). */
    fun adminPage(url: HttpUrl): String = "${display(url)}/admin"
}
