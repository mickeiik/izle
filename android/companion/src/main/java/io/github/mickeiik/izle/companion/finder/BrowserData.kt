package io.github.mickeiik.izle.companion.finder

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView

/** What the link finder's browser keeps between visits: its cookies, web storage, cache and history. */
object BrowserData {
    /** Clears it all; [onDone] runs on the calling thread (the main thread) once the cookies are gone. */
    fun clear(context: Context, onDone: () -> Unit = {}) {
        WebStorage.getInstance().deleteAllData()
        WebView(context).apply {
            clearCache(true)
            clearHistory()
            destroy()
        }
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies {
            cookies.flush()
            onDone()
        }
    }
}
