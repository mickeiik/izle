package io.github.mickeiik.izle.update

import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import io.github.mickeiik.izle.data.ProblemReporter
import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.domain.Problems
import io.github.mickeiik.izle.settings.DeviceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

/** What the system said about an install session (see [AppUpdater.onInstallStatus]). */
sealed interface InstallStatus {
    /** Guided: the system's Install/Cancel dialog, for the activity to start. */
    data class NeedsConfirmation(val intent: Intent) : InstallStatus

    /** A silent install the system wanted confirmed: abandoned; this TV updates guided from now on. */
    data object SilentRefused : InstallStatus

    data object Succeeded : InstallStatus

    /** [reason]: `install_failure_storage`, …; [aborted]: the viewer chose Cancel in the system dialog. */
    data class Failed(val reason: String, val aborted: Boolean = false) : InstallStatus
}

/** How one [AppUpdater.run] ended. */
sealed interface UpdateRun {
    /** The session is committed: the system takes over (and the process usually ends). */
    data object Committed : UpdateRun
    data class Ignored(val reason: String) : UpdateRun
    data class Failed(val reason: String) : UpdateRun
}

/**
 * The TV's self-update: what the server offers ([available], from `GET /tv/app`), how this TV can install it
 * ([capability], and the API `User-Agent` that tells the server), and one update at a time: download, check, commit.
 * The system's answer comes back through [onInstallStatus]. Main thread.
 */
class AppUpdater(
    private val scope: CoroutineScope,
    private val store: DeviceStore,
    private val downloader: ApkDownloader,
    private val installer: () -> AppInstaller,
    private val problems: ProblemReporter,
    /** The capability for a given `silentRefused` (Android version and the "install unknown apps" grant, live). */
    private val capabilityOf: (silentRefused: Boolean) -> UpdateCapability,
    val installedVersionCode: Long,
    private val versionName: String,
    private val sdkInt: Int,
    private val wallClock: () -> Long = System::currentTimeMillis,
) {
    private val _available = MutableStateFlow<AvailableUpdate?>(null)
    val available: StateFlow<AvailableUpdate?> = _available.asStateFlow()

    private val _capability = MutableStateFlow(capabilityOf(false))
    val capability: StateFlow<UpdateCapability> = _capability.asStateFlow()

    /**
     * The `User-Agent` of every API call; changes with [capability]. Null until the stored refusal is read (OkHttp's
     * own then goes out, which the server does not record): a refused TV must not say `silent` meanwhile.
     */
    @Volatile
    var userAgent: String? = null
        private set

    private val _installStatus = MutableSharedFlow<InstallStatus>(extraBufferCapacity = 8)
    val installStatus: SharedFlow<InstallStatus> = _installStatus.asSharedFlow()

    @Volatile
    private var silentRefused = false
    private var lastFailureStored: Long? = null

    /** When this process last committed a session (an install under way, or one the system never answered). */
    private var lastCommitAt: Long? = null

    /** Sessions committed by this process: only their statuses count (the activity takes intents from anyone). */
    private val committed = mutableMapOf<Int, Boolean>()

    /** A download or install is under way. */
    var busy: Boolean = false
        private set

    /** The stored refusal and last failure have been read ([loaded]). */
    @Volatile
    private var ready = false

    /** Reads the stored refusal and last failure, once at start (last here: it may run at once). */
    private val loaded: Job = scope.launch {
        val settings = store.current()
        // Without losing what happened meanwhile.
        silentRefused = silentRefused || settings.updateSilentRefused
        lastFailureStored = lastFailureStored ?: settings.lastUpdateFailureAt
        ready = true
        refreshCapability()
    }

    /** No automatic attempt for a while after this (wall clock): the last failure, or a commit still unanswered. */
    val lastFailureAt: Long?
        get() = listOfNotNull(lastFailureStored, lastCommitAt).maxOrNull()

    /** Reads the capability again (the "install unknown apps" grant may have changed while the app was away). */
    fun refreshCapability() {
        val capability = capabilityOf(silentRefused)
        _capability.value = capability
        if (ready) userAgent = UpdateCapabilities.userAgent(versionName, installedVersionCode, sdkInt, capability)
    }

    /** Whether the server offers a version newer than this one. */
    fun newer(update: AvailableUpdate? = _available.value): AvailableUpdate? = update?.takeIf { it.versionCode > installedVersionCode }

    /** `GET /tv/app`; a network failure keeps what was known, a server without the route (404) offers nothing. */
    suspend fun check(api: ApiClient): AvailableUpdate? {
        try {
            _available.value = api.app()
        } catch (e: ApiException) {
            if (e.status == 404) _available.value = null
        } catch (e: IOException) {
            // keeps the last answer
        }
        return _available.value
    }

    /**
     * Downloads [update], checks the archive, then [beforeCommit] (false: not now after all, `ignored busy`; this is
     * where a command's result goes out, as the process ends when the install succeeds), then commits the session.
     * Failures go to the owner as problem reports when no command result tells of them: without a command
     * ([commandId] null), or once [beforeCommit] let the install go ahead (the command's `done` is out). Cancelled
     * (Back on the guided screen) is no failure: nothing is remembered or reported, and no file is kept.
     */
    suspend fun run(api: ApiClient, update: AvailableUpdate, silent: Boolean, commandId: Long?, beforeCommit: suspend () -> Boolean): UpdateRun {
        if (busy) return UpdateRun.Ignored(CommandResult.BUSY)
        busy = true
        var committing = false
        try {
            val file = downloader.download(api, update)
            installer().verifyArchive(file, update.versionCode)
            if (!beforeCommit()) {
                downloader.clear()
                return UpdateRun.Ignored(CommandResult.BUSY)
            }
            committing = true
            val sessionId = installer().install(file, silent)
            committed[sessionId] = silent
            lastCommitAt = wallClock()
            return UpdateRun.Committed
        } catch (e: UpdateException) {
            downloader.clear()
            // A cancelled download ends in an interrupted read, which surfaces here.
            currentCoroutineContext().ensureActive()
            if (e.ignored) return UpdateRun.Ignored(e.reason)
            failed(e.reason, report = commandId == null || committing)
            return UpdateRun.Failed(e.reason)
        } catch (e: ApiException) {
            downloader.clear()
            currentCoroutineContext().ensureActive()
            if (e.status == 404) {
                // Nothing stored any more (the owner removed it meanwhile): nothing to offer either.
                _available.value = null
                return UpdateRun.Ignored(CommandResult.UP_TO_DATE)
            }
            failed(CommandResult.DOWNLOAD, report = commandId == null || committing)
            return UpdateRun.Failed(CommandResult.DOWNLOAD)
        } catch (e: CancellationException) {
            downloader.clear()
            throw e
        } catch (e: Exception) {
            // Anything else still ends on Home ("Could not update"), never in a crash.
            downloader.clear()
            currentCoroutineContext().ensureActive()
            failed(CommandResult.INTERNAL, report = commandId == null || committing)
            return UpdateRun.Failed(CommandResult.INTERNAL)
        } finally {
            busy = false
        }
    }

    /**
     * The status of a session this process committed (`ACTION_INSTALL_STATUS`, from the activity). Pending user
     * action: guided, the system dialog for the activity to start; silent, the system refuses to install unattended,
     * so the session is abandoned and this TV is guided from now on. Success cleans up (if the process lives to see
     * it); a failure is remembered (no automatic attempt for a while) and reported to the owner.
     */
    fun onInstallStatus(intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, NO_STATUS)
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (status == PackageInstaller.STATUS_SUCCESS) {
            // Usually seen by the new version, started by this very intent (a new process: no sessions, nothing
            // under way). Otherwise only for a session this process committed.
            val ours = sessionId in committed || (committed.isEmpty() && !busy)
            if (!ours) return
            committed.remove(sessionId)
            downloader.clear()
            _installStatus.tryEmit(InstallStatus.Succeeded)
            return
        }
        val silent = committed[sessionId] ?: return
        if (status == NO_STATUS) return
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
            val trusted = confirm != null && installer().ownsSession(sessionId) && installer().isSystemConfirmation(confirm)
            if (!silent && trusted) {
                _installStatus.tryEmit(InstallStatus.NeedsConfirmation(confirm))
                return
            }
            committed.remove(sessionId)
            installer().abandon(sessionId)
            downloader.clear()
            lastCommitAt = null
            if (silent) {
                silentRefused = true
                scope.launch { store.setUpdateSilentRefused(true) }
                refreshCapability()
                problems.send(Problems.update(NEEDS_USER_ACTION, versionName))
                _installStatus.tryEmit(InstallStatus.SilentRefused)
            } else {
                // No usable confirmation came with it.
                val name = UpdatePlan.installStatusName(status)
                failed(name, report = true)
                _installStatus.tryEmit(InstallStatus.Failed(CommandResult.INSTALL_PREFIX + name))
            }
            return
        }
        committed.remove(sessionId)
        downloader.clear()
        lastCommitAt = null
        val name = UpdatePlan.installStatusName(status)
        val aborted = status == PackageInstaller.STATUS_FAILURE_ABORTED && !silent
        // Cancel in the system dialog is the viewer's answer, not a failure.
        if (!aborted) failed(name, report = true)
        _installStatus.tryEmit(InstallStatus.Failed(CommandResult.INSTALL_PREFIX + name, aborted))
    }

    /** The app was replaced by a newer version (`MY_PACKAGE_REPLACED`): silent may work again; nothing to keep. */
    suspend fun onReplaced() {
        // The start's read must not bring back what is cleared here.
        loaded.join()
        silentRefused = false
        store.setUpdateSilentRefused(false)
        store.setLastUpdateFailureAt(null)
        lastFailureStored = null
        _available.value = null
        downloader.clear()
        refreshCapability()
    }

    private fun failed(code: String, report: Boolean) {
        val now = wallClock()
        lastFailureStored = now
        scope.launch { store.setLastUpdateFailureAt(now) }
        if (report) problems.send(Problems.update(code, versionName))
    }

    companion object {
        const val NEEDS_USER_ACTION = "needs_user_action"
        private const val NO_STATUS = Int.MIN_VALUE
    }
}
