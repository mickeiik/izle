package io.github.mickeiik.izle.companion.connect

import android.content.ContentResolver
import android.os.Build
import android.provider.Settings
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * `izle-companion://connect?server=<url>&invite=<invite>`: what the server's `/connect` page opens after the phone's
 * camera scanned the QR code a TV shows (hidden menu → Settings → Connect a phone). The app claims [invite] at once.
 */
data class ConnectLink(val server: String, val invite: String) {
    /** Never the invite: it is a credential until claimed. */
    override fun toString(): String = "ConnectLink(server=$server)"

    companion object {
        const val SCHEME = "izle-companion"
        const val HOST = "connect"

        /** Null unless [link] is this app's connect link with both a server and an invite. */
        fun parse(link: String?): ConnectLink? {
            val uri = try {
                URI(link ?: return null)
            } catch (e: URISyntaxException) {
                return null
            }
            if (!uri.scheme.equals(SCHEME, ignoreCase = true) || !uri.host.equals(HOST, ignoreCase = true)) return null
            val params = uri.rawQuery.orEmpty().split('&').mapNotNull { pair ->
                val name = pair.substringBefore('=')
                if (name.isEmpty() || '=' !in pair) return@mapNotNull null
                val value = try {
                    URLDecoder.decode(pair.substringAfter('='), "UTF-8")
                } catch (e: IllegalArgumentException) {
                    return@mapNotNull null
                }
                name to value.trim()
            }.toMap()
            val server = params["server"]?.takeIf { it.isNotEmpty() } ?: return null
            val invite = params["invite"]?.takeIf { it.isNotEmpty() } ?: return null
            return ConnectLink(server, invite)
        }
    }
}

/** The name a claim gives this phone: the one set in the phone's settings, else its model (1–60 characters). */
fun phoneName(resolver: ContentResolver): String {
    val set = try {
        Settings.Global.getString(resolver, Settings.Global.DEVICE_NAME)
    } catch (e: SecurityException) {
        null
    }
    val name = set?.trim()?.takeIf { it.isNotEmpty() } ?: Build.MODEL?.trim()?.takeIf { it.isNotEmpty() } ?: "Phone"
    return name.take(60)
}
