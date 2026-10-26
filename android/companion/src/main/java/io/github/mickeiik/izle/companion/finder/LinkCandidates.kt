package io.github.mickeiik.izle.companion.finder

/*
 * The link finder's rules, pure: which request is worth a look, what a playlist starts with, which of the page's
 * request headers go with a found link, and what the address row turns typed text into.
 */

/**
 * A request worth confirming: `http`/`https`, with `m3u8` in its path or query (case-insensitive). Signed CDN links
 * often carry it somewhere other than an extension (`…/m3u8/abc?payload=…`), which is why the confirming fetch decides.
 * A path ending in an extension that is never a playlist ([NOT_PLAYLISTS]: images, media segments, keys, subtitles,
 * page assets) is not one, wherever `m3u8` appears: some CDNs serve a site's segments and thumbnails under the
 * playlist's path.
 */
fun isCandidate(url: String): Boolean {
    val rest = afterAuthority(url) ?: return false
    if (!rest.contains("m3u8", ignoreCase = true)) return false
    val path = rest.substringBefore('?').substringBefore('#')
    val extension = path.substringAfterLast('/').substringAfterLast('.', missingDelimiterValue = "").lowercase()
    return extension !in NOT_PLAYLISTS
}

/** The extensions of a path that is never a playlist, lower-case. */
private val NOT_PLAYLISTS = setOf(
    "jpg", "jpeg", "png", "gif", "webp", "svg", "ico",
    "ts", "m4s", "mp4", "m4a", "m4v", "aac", "mp3",
    "key", "vtt", "srt",
    "js", "css", "woff", "woff2", "json", "xml", "html",
)

/** An `http` or `https` URL with a host: what a pasted link must be. */
fun isHttpUrl(url: String): Boolean = afterAuthority(url) != null

/** The path, query and fragment of an `http(s)` URL with a non-empty authority (`""` for none); null for anything else. */
private fun afterAuthority(url: String): String? {
    val scheme = when {
        url.startsWith("https://", ignoreCase = true) -> "https://"
        url.startsWith("http://", ignoreCase = true) -> "http://"
        else -> return null
    }
    val start = scheme.length
    val end = url.indexOfAny(charArrayOf('/', '?', '#'), start).let { if (it < 0) url.length else it }
    if (end == start || url.substring(start, end).any { it.isWhitespace() }) return null
    return url.substring(end)
}

private val EXTM3U = "#EXTM3U".toByteArray(Charsets.US_ASCII)

/** The start of a body is an HLS playlist: an optional UTF-8 BOM and leading whitespace, then `#EXTM3U`. */
fun looksLikePlaylist(start: ByteArray): Boolean {
    var i = 0
    if (start.size >= 3 && start[0] == 0xEF.toByte() && start[1] == 0xBB.toByte() && start[2] == 0xBF.toByte()) i = 3
    while (i < start.size && start[i].toInt().toChar() in " \t\r\n") i++
    if (start.size - i < EXTM3U.size) return false
    return EXTM3U.indices.all { start[i + it] == EXTM3U[it] }
}

/**
 * The headers a found link is played with: the page's `Referer` and `Origin` (looked up case-insensitively, sent under
 * these names) and the WebView's cookies for the link. Nothing else: no `User-Agent`, no `Authorization`.
 *
 * A WebView's request headers often lack `Referer` (and never carry cookies), and some hosts answer a playlist request
 * without `Referer` and `Origin` with a redirect: when [pageUrl] (the page's current `http(s)` URL) is given, a missing
 * `Referer` is the page URL and a missing `Origin` its origin (`scheme://host[:port]`). The request's own values win.
 */
fun headersFor(requestHeaders: Map<String, String>, cookie: String?, pageUrl: String? = null): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    val page = pageUrl?.trim()?.takeIf(::isHttpUrl)
    for (name in listOf("Referer", "Origin")) {
        val value = requestHeaders.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
        val fallback = when {
            page == null -> null
            name == "Referer" -> page
            else -> originOf(page)
        }
        val chosen = value?.takeUnless { it.isBlank() } ?: fallback
        if (!chosen.isNullOrBlank()) out[name] = chosen
    }
    if (!cookie.isNullOrBlank()) out["Cookie"] = cookie
    return out
}

/** The origin of an `http(s)` URL: its scheme (lower-cased) and authority without user info (`scheme://host[:port]`). */
fun originOf(url: String): String? {
    if (afterAuthority(url) == null) return null
    val schemeEnd = url.indexOf("://")
    val scheme = url.substring(0, schemeEnd).lowercase()
    val start = schemeEnd + 3
    val end = url.indexOfAny(charArrayOf('/', '?', '#'), start).let { if (it < 0) url.length else it }
    val authority = url.substring(start, end).substringAfterLast('@')
    return authority.takeIf { it.isNotEmpty() }?.let { "$scheme://$it" }
}

/**
 * What the address row loads for [text]: trimmed, `https://` prepended when no scheme is given; null when blank or
 * another scheme (`file://`, `content://`, …).
 */
fun addressUrl(text: String): String? {
    val t = text.trim()
    if (t.isEmpty()) return null
    if (isHttpUrl(t)) return t
    if (t.contains("://") || t.any { it.isWhitespace() }) return null
    return "https://$t".takeIf(::isHttpUrl)
}
