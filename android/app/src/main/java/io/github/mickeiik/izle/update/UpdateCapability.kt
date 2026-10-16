package io.github.mickeiik.izle.update

import android.content.Context
import android.os.Build

/**
 * How this TV installs a new version of the app. [Silent]: by itself, without a dialog (Android 12+, with the
 * one-time "install unknown apps" grant). [Guided]: the system's Install/Cancel dialog, which someone has to answer.
 */
enum class UpdateCapability {
    Silent,
    Guided,
    ;

    /** As the `User-Agent` spells it. */
    val wire: String get() = name.lowercase()
}

object UpdateCapabilities {
    /** `PackageInstaller.SessionParams.setRequireUserAction` (Android 12). */
    const val SILENT_MIN_SDK = 31

    /**
     * Silent needs Android 12+, the "install unknown apps" grant, and no unattended attempt that the system turned into
     * a dialog anyway ([silentRefused]). Checked at runtime, so the same build turns silent when the TV's OS is upgraded.
     */
    fun of(sdkInt: Int, canRequestInstalls: Boolean, silentRefused: Boolean): UpdateCapability =
        if (sdkInt >= SILENT_MIN_SDK && canRequestInstalls && !silentRefused) UpdateCapability.Silent else UpdateCapability.Guided

    /** Below Android 8 there is no per-app grant (the global "Unknown sources" setting decides in the dialog). */
    fun canRequestInstalls(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true

    fun current(context: Context, silentRefused: Boolean): UpdateCapability =
        of(Build.VERSION.SDK_INT, canRequestInstalls(context), silentRefused)

    /** The `User-Agent` of every API call: `izle-tv/0.2.0 (Android 25; 200; guided)`. The server records it per TV. */
    fun userAgent(versionName: String, versionCode: Long, sdkInt: Int, capability: UpdateCapability): String =
        "izle-tv/$versionName (Android $sdkInt; $versionCode; ${capability.wire})"
}
