package io.github.mickeiik.izle.companion.tv

// The server's refusals in words, as the admin page's lib.js `errorText` says them: one wording for every tab.

/** No answer from the server. */
const val UNREACHABLE = "The server cannot be reached."

/** An API error code in words; null for a code without words of its own (the caller says it its way). */
fun apiErrorText(code: String): String? = API_ERRORS[code]

private val API_ERRORS = mapOf(
    "unauthorized" to "This phone was disconnected.",
    "insufficient_scope" to "This connection may not do that.",
    "not_allowed" to "Playback of that episode is not allowed by the catalog.",
    "unknown_episode" to "That episode is not in the catalog (any more).",
    "unknown_device" to "That TV does not exist any more.",
    "unknown_source" to "That source is not in the catalog (any more).",
    "unsupported_media" to "The server does not offer that source's DASH or MPEG-TS stream to a phone.",
    "no_playable_source" to "The source could not be resolved right now.",
    "no_link" to "Save the timing for this episode first.",
    "invalid_request" to "The server did not accept the request.",
)
