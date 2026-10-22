package io.github.mickeiik.izle.update

import android.content.Context
import android.os.Build

/**
 * [Silent]: by itself, without a dialog (Android 12+, with the one-time "install unknown apps" grant). [Guided]: the
 * system's Install/Cancel dialog, which someone has to answer.
 */
enum class UpdateCapability { Silent, Guided }

object UpdateCapabilities {
    /** `PackageInstaller.SessionParams.setRequireUserAction` (Android 12). */
    const val SILENT_MIN_SDK = 31

    /** At runtime, so the same build turns silent when the TV's OS is upgraded; [silentRefused]: the system asked anyway. */
    fun of(sdkInt: Int, canRequestInstalls: Boolean, silentRefused: Boolean): UpdateCapability =
        if (sdkInt >= SILENT_MIN_SDK && canRequestInstalls && !silentRefused) UpdateCapability.Silent else UpdateCapability.Guided

    /** Below Android 8 there is no per-app grant (the global "Unknown sources" setting decides in the dialog). */
    fun current(context: Context, silentRefused: Boolean): UpdateCapability {
        val canRequestInstalls = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
        return of(Build.VERSION.SDK_INT, canRequestInstalls, silentRefused)
    }

    /** `izle-tv/0.2.0 (Android 25; 200; guided)`, recorded per TV by the server. */
    fun userAgent(versionName: String, versionCode: Long, sdkInt: Int, capability: UpdateCapability): String =
        "izle-tv/$versionName (Android $sdkInt; $versionCode; ${capability.name.lowercase()})"
}
