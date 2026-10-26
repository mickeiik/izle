package io.github.mickeiik.izle.companion.finder

/**
 * A playlist link found on this phone, with the request headers the page sent for it (`Referer`, `Origin`, `Cookie`;
 * only those present). It lives in memory for the session: never stored, never sent to the server, never logged
 * ([toString] shows the header names only).
 */
data class FoundLink(val url: String, val headers: Map<String, String>) {
    override fun toString(): String = "FoundLink(headers=${headers.keys})"
}
