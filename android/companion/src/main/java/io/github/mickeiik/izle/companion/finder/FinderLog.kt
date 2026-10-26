package io.github.mickeiik.izle.companion.finder

import android.util.Log
import io.github.mickeiik.izle.companion.BuildConfig

/**
 * The link finder's diagnostics, in debug builds only (`adb logcat -s izle.finder`): which step a candidate got to.
 * A line never holds a URL, a header value or a cookie, in any build; the confirm outcome lines may name the host.
 * Release builds write nothing (the [BuildConfig.DEBUG] check folds away).
 */
object FinderLog {
    const val TAG = "izle.finder"

    /** Where the lines go: logcat. Plain JVM tests, where `android.util.Log` is a stub, replace it. */
    @Volatile
    internal var sink: (String) -> Unit = { Log.d(TAG, it) }

    fun d(message: String) {
        if (BuildConfig.DEBUG) sink(message)
    }

    internal fun yesNo(value: Boolean) = if (value) "yes" else "no"
}
