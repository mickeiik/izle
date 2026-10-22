package io.github.mickeiik.izle.update

import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.ui.Screen
import kotlinx.serialization.Serializable

/** The TV app version the server offers (`GET /tv/app`). [auto]: the owner lets TVs install it by themselves. */
@Serializable
data class AvailableUpdate(val versionName: String, val versionCode: Long, val sha256: String, val size: Long, val auto: Boolean = true)

/**
 * When the TV installs a new version of itself (docs/ux/senior-tv.md, "Update"), never during playback. A
 * [UpdateCapability.Silent] TV installs by itself once idle on Home for [IDLE_MS], or at once on the owner's `update`
 * command; a [UpdateCapability.Guided] one only on the command, behind a full-screen "press OK". Pure.
 */
object UpdatePlan {
    /** Home without a key press for this long: nobody is using the TV. */
    const val IDLE_MS = 3 * 60_000L
    const val GUIDED_TIMEOUT_SEC = 60
    const val FAILED_HOME_SEC = 15

    /** A broken APK is not downloaded every 30 s. */
    const val RETRY_AFTER_FAILURE_MS = 6 * 3_600_000L
    const val AUTO_TICK_MS = 30_000L

    /** "Updating…" goes Home when the system never answers (the install normally restarts the app). */
    const val INSTALLING_MAX_MS = 2 * 60_000L

    /** [idleMs]: since the last key press, the app coming to the front or playback ending; [now]: wall clock. */
    data class Context(
        val capability: UpdateCapability,
        val installedVersionCode: Long,
        val screen: Screen,
        val menuOpen: Boolean,
        val autoplayShowing: Boolean,
        val playerInUse: Boolean,
        val online: Boolean,
        val idleMs: Long,
        val lastFailureAt: Long?,
        val now: Long,
        val busy: Boolean = false,
    )

    sealed interface Action {
        /** Reports its own result. */
        data class Install(val update: AvailableUpdate, val silent: Boolean) : Action

        /** "New version — press OK" (its result comes with the viewer's answer). */
        data class ShowGuided(val update: AvailableUpdate) : Action
        data class Report(val result: CommandResult) : Action
    }

    private fun ignored(reason: String) = listOf(Action.Report(CommandResult.ignored(reason)))

    /** The owner's `update` (or the hidden menu's); [versionCode] null: whatever is offered. */
    fun onCommand(update: AvailableUpdate?, versionCode: Long?, ctx: Context): List<Action> = when {
        ctx.screen != Screen.Home && ctx.screen != Screen.Player && ctx.screen !is Screen.Update -> ignored(CommandResult.NOT_READY)
        ctx.screen == Screen.Player || ctx.playerInUse || ctx.busy || ctx.screen is Screen.Update -> ignored(CommandResult.BUSY)
        update == null || update.versionCode <= ctx.installedVersionCode -> ignored(CommandResult.UP_TO_DATE)
        versionCode != null && versionCode <= ctx.installedVersionCode -> ignored(CommandResult.UP_TO_DATE)
        ctx.capability == UpdateCapability.Silent -> listOf(Action.Install(update, silent = true))
        else -> listOf(Action.ShowGuided(update))
    }

    fun autoInstall(update: AvailableUpdate?, ctx: Context): Boolean =
        update != null && ctx.capability == UpdateCapability.Silent && update.auto &&
            update.versionCode > ctx.installedVersionCode &&
            ctx.screen == Screen.Home && !ctx.menuOpen && !ctx.autoplayShowing && !ctx.playerInUse && ctx.online &&
            !ctx.busy && ctx.idleMs >= IDLE_MS && !failedRecently(ctx)

    /** A failure in the last [RETRY_AFTER_FAILURE_MS]; one in the future (the clock was set back) does not hold it up. */
    private fun failedRecently(ctx: Context): Boolean {
        val since = ctx.now - (ctx.lastFailureAt ?: return false)
        return since in 0 until RETRY_AFTER_FAILURE_MS
    }

    /** A `PackageInstaller.STATUS_*` (-1 to 8) without the prefix, lower-case (`failure_storage`); unknown ones by number. */
    fun installStatusName(status: Int): String = STATUS_NAMES.getOrNull(status + 1) ?: "status_$status"

    private val STATUS_NAMES = listOf(
        "pending_user_action", "success", "failure", "failure_blocked", "failure_aborted", "failure_invalid", "failure_conflict",
        "failure_storage", "failure_incompatible", "failure_timeout",
    )
}
