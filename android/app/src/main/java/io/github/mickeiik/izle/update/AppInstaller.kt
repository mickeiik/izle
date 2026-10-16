package io.github.mickeiik.izle.update

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.MainActivity
import io.github.mickeiik.izle.data.api.CommandResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** The system side of an update; replaced by a fake in the tests. */
interface AppInstaller {
    /**
     * Throws [UpdateException] unless [file] is this app (`wrong_package`), newer than the running version
     * (`not_newer`, ignored) and the version the server announced; `bad_archive` when it is no APK at all or another
     * version than announced.
     */
    suspend fun verifyArchive(file: File, expectedVersionCode: Long)

    /**
     * Writes [file] into an install session and commits it; the outcome comes back to [MainActivity] as an
     * [ACTION_INSTALL_STATUS] intent. [silent]: asks the system not to show its dialog. Returns the session id.
     * Throws [UpdateException] `install_write` when the session could not be written.
     */
    suspend fun install(file: File, silent: Boolean, commandId: Long?): Int

    /** Whether [sessionId] is an install session this app opened (a status intent can come from any app). */
    fun ownsSession(sessionId: Int): Boolean

    /**
     * Whether [intent] (a status's confirmation) may be started: not one that opens another app than a system one. The
     * session check ([ownsSession], random session ids) is what keeps other apps out; this is a second look.
     */
    fun isSystemConfirmation(intent: Intent): Boolean

    fun abandon(sessionId: Int)

    companion object {
        const val ACTION_INSTALL_STATUS = "io.github.mickeiik.izle.INSTALL_STATUS"
        const val EXTRA_COMMAND_ID = "izle.commandId"
        const val EXTRA_SILENT = "izle.silent"
    }
}

/** [AppInstaller] on the platform's [PackageInstaller]. */
class PackageInstallerAppInstaller(private val context: Context) : AppInstaller {
    private val installedVersionCode: Long = BuildConfig.VERSION_CODE.toLong()

    override suspend fun verifyArchive(file: File, expectedVersionCode: Long) = withContext(Dispatchers.IO) {
        val info = context.packageManager.getPackageArchiveInfo(file.path, 0) ?: throw UpdateException(CommandResult.BAD_ARCHIVE)
        if (info.packageName != context.packageName) throw UpdateException(CommandResult.WRONG_PACKAGE)
        val code = PackageInfoCompat.getLongVersionCode(info)
        if (code <= installedVersionCode) throw UpdateException(CommandResult.NOT_NEWER, ignored = true)
        if (code != expectedVersionCode) throw UpdateException(CommandResult.BAD_ARCHIVE)
    }

    override suspend fun install(file: File, silent: Boolean, commandId: Long?): Int = withContext(Dispatchers.IO) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(file.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(
                    if (silent) PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED else PackageInstaller.SessionParams.USER_ACTION_REQUIRED,
                )
            }
        }
        val sessionId = try {
            installer.createSession(params)
        } catch (e: IOException) {
            throw UpdateException(INSTALL_WRITE)
        }
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("izle.apk", 0, file.length()).use { output ->
                        input.copyTo(output, 64 * 1024)
                        session.fsync(output)
                    }
                }
                session.commit(statusReceiver(silent, commandId).intentSender)
            }
        } catch (e: Exception) {
            if (e is SecurityException || e is IOException || e is IllegalStateException) {
                runCatching { installer.abandonSession(sessionId) }
                throw UpdateException(INSTALL_WRITE)
            }
            throw e
        }
        sessionId
    }

    /**
     * The status comes back as an activity start of [MainActivity], delivered while the app is visible (the guided
     * path's "user action required"). It does not bring the new version back after a silent self-update: the old
     * process is gone by then and the package installer sends the intent with background activity starts denied
     * (Android 10+ blocks it; verified on API 36), so the TV shows its launcher until izle is opened again. Mutable
     * from Android 12: the system adds the status extras.
     */
    private fun statusReceiver(silent: Boolean, commandId: Long?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(AppInstaller.ACTION_INSTALL_STATUS)
            .putExtra(AppInstaller.EXTRA_SILENT, silent)
        if (commandId != null) intent.putExtra(AppInstaller.EXTRA_COMMAND_ID, commandId)
        val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        // Android 14+: the creator allows the activity start it was made for (Android 15 denies it by default).
        val options = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ActivityOptions.makeBasic()
                .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                .toBundle()
        } else {
            null
        }
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable, options)
    }

    override fun ownsSession(sessionId: Int): Boolean =
        runCatching { context.packageManager.packageInstaller.mySessions.any { it.sessionId == sessionId } }.getOrDefault(false)

    override fun isSystemConfirmation(intent: Intent): Boolean {
        // Android 11+ may hide the system installer from this app (package visibility): unresolvable is not a reason.
        val resolved = runCatching {
            context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
        }.getOrNull() ?: return true
        val flags = resolved.activityInfo?.applicationInfo?.flags ?: return true
        return flags and ApplicationInfo.FLAG_SYSTEM != 0
    }

    override fun abandon(sessionId: Int) {
        runCatching { context.packageManager.packageInstaller.abandonSession(sessionId) }
    }

    companion object {
        const val INSTALL_WRITE = "install_write"
    }
}
