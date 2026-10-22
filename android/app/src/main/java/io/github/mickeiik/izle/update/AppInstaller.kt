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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** The system side of an update; replaced by a fake in the tests. */
interface AppInstaller {
    /**
     * Throws [UpdateException] unless [file] is this app (`wrong_package`), the announced version (`bad_archive`, as
     * when it is no APK) and newer than this one (`not_newer`, ignored). In that order: a mislabelled archive is a
     * failure, not an older version.
     */
    suspend fun verifyArchive(file: File, expectedVersionCode: Long)

    /**
     * Commits [file] in an install session and returns its id; the outcome comes back to [MainActivity] as an
     * [ACTION_INSTALL_STATUS] intent. Throws [UpdateException] `install_write` when the session could not be written.
     */
    suspend fun install(file: File, silent: Boolean): Int

    /** A status intent can come from any app. */
    fun ownsSession(sessionId: Int): Boolean

    /** A second look after [ownsSession] (random session ids): a confirmation must not open another app than a system one. */
    fun isSystemConfirmation(intent: Intent): Boolean

    fun abandon(sessionId: Int)

    companion object {
        const val ACTION_INSTALL_STATUS = "io.github.mickeiik.izle.INSTALL_STATUS"
    }
}

/** [AppInstaller] on the platform's [PackageInstaller]. */
class PackageInstallerAppInstaller(private val context: Context) : AppInstaller {
    private val installedVersionCode: Long = BuildConfig.VERSION_CODE.toLong()

    override suspend fun verifyArchive(file: File, expectedVersionCode: Long) = withContext(Dispatchers.IO) {
        val info = context.packageManager.getPackageArchiveInfo(file.path, 0) ?: throw UpdateException(CommandResult.BAD_ARCHIVE)
        if (info.packageName != context.packageName) throw UpdateException(CommandResult.WRONG_PACKAGE)
        val code = PackageInfoCompat.getLongVersionCode(info)
        if (code != expectedVersionCode) throw UpdateException(CommandResult.BAD_ARCHIVE)
        if (code <= installedVersionCode) throw UpdateException(CommandResult.NOT_NEWER, ignored = true)
    }

    override suspend fun install(file: File, silent: Boolean): Int = withContext(Dispatchers.IO) {
        // IOException, SecurityException (installation services unavailable), IllegalArgumentException (parameters
        // this Android refuses): all `install_write`.
        val (installer, sessionId) = try {
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
            installer to installer.createSession(params)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
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
                session.commit(statusReceiver().intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            if (e is CancellationException) throw e
            throw UpdateException(INSTALL_WRITE)
        }
        sessionId
    }

    /**
     * An activity start of [MainActivity], delivered while the app is visible (the guided path). It does not bring the
     * new version back after a silent self-update: the installer sends it with background activity starts denied
     * (Android 10+; verified on API 36). Mutable from Android 12: the system adds the status extras.
     */
    private fun statusReceiver(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).setAction(AppInstaller.ACTION_INSTALL_STATUS)
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
