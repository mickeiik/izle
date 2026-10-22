package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.player.PlayerPhase

/**
 * What the owner's commands do on this TV: they act only on Home and in the player. Transport commands need video
 * showing and win over the hidden menu (`resume`, `next`, `previous` close it, `pause` keeps closing it from resuming,
 * `seek` happens under it). A channel is never paused (`ignored`, `live`); `next`/`previous` zap as CH+/CH− do, also
 * from its error screen. Every command ends in exactly one result: a [Action.Report] last, or the [Action.Play],
 * [Action.Step], [Action.Zap] or [Action.Update] that reports it later.
 */
object CommandPlan {
    sealed interface Action {
        data class Play(val command: RemoteCommand.Play) : Action
        data object Exit : Action
        data object Pause : Action
        data object Resume : Action
        data class Seek(val command: RemoteCommand.Seek) : Action

        /** The next (+1) or previous (−1) episode, or channel on Home. */
        data class Step(val direction: Int) : Action
        data class Zap(val direction: Int) : Action

        /** [resume]: resumes playback if opening the menu paused it. */
        data class CloseMenu(val resume: Boolean) : Action

        /** Closing the hidden menu later (open now or not) does not resume playback. */
        data object StayPausedAfterMenu : Action
        data class ShowMessage(val message: RemoteCommand.Message) : Action
        data class Report(val result: CommandResult) : Action
        data class Update(val command: RemoteCommand.Update) : Action
    }

    private val done = Action.Report(CommandResult.Done)

    /** The actions, in order, for [command] on [screen] with the player in [phase]; [live]: it plays a channel. */
    fun actions(command: RemoteCommand, screen: Screen, phase: PlayerPhase, menuOpen: Boolean, live: Boolean = false): List<Action> {
        // An `update` while the update screen shows is the update plan's (`busy`).
        val ready = screen == Screen.Home || screen == Screen.Player || (screen is Screen.Update && command is RemoteCommand.Update)
        if (!ready && command !is RemoteCommand.Ignored) return listOf(Action.Report(CommandResult.ignored(CommandResult.NOT_READY)))
        val video = screen == Screen.Player && phase == PlayerPhase.Playing
        // A channel zaps on while the next one loads, as CH+/CH− do.
        val channel = live && screen == Screen.Player && (phase == PlayerPhase.Playing || phase == PlayerPhase.Loading)
        // And from its error screen, where no other transport command applies (no video showing).
        val zaps = channel || (live && screen == Screen.Player && phase is PlayerPhase.Failed)
        val notInPlayer = listOf(Action.Report(CommandResult.ignored(CommandResult.NOT_IN_PLAYER)))
        val noPause = listOf(Action.Report(CommandResult.ignored(CommandResult.LIVE)))
        fun closingMenu(resume: Boolean) = if (menuOpen) listOf(Action.CloseMenu(resume)) else emptyList()
        return when (command) {
            is RemoteCommand.Play -> listOf(Action.Play(command))
            RemoteCommand.Stop -> if (screen == Screen.Player) listOf(Action.Exit, done) else notInPlayer
            RemoteCommand.Pause -> if (channel) noPause else if (video) listOf(Action.StayPausedAfterMenu, Action.Pause, done) else notInPlayer
            RemoteCommand.Resume -> if (channel) noPause else if (video) closingMenu(resume = false) + Action.Resume + done else notInPlayer
            is RemoteCommand.Seek -> if (channel) noPause else if (video) listOf(Action.Seek(command), done) else notInPlayer
            RemoteCommand.Next, RemoteCommand.Previous -> {
                val direction = if (command == RemoteCommand.Next) 1 else -1
                when {
                    zaps -> closingMenu(resume = true) + Action.Zap(direction)
                    video -> closingMenu(resume = true) + Action.Step(direction)
                    else -> notInPlayer
                }
            }
            is RemoteCommand.Message -> listOf(Action.ShowMessage(command), done)
            is RemoteCommand.Update -> listOf(Action.Update(command))
            // A newer server's command, or an unusable one: acknowledged, nothing else.
            is RemoteCommand.Ignored -> listOf(Action.Report(CommandResult.ignored(CommandResult.UNKNOWN_TYPE)))
        }
    }
}
