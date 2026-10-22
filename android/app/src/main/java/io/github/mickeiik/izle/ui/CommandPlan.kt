package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.domain.PlayableRef
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.player.PlayerPhase

/**
 * What the owner's commands do on this TV. They act only on Home and in the player (the repository acknowledges every
 * command right after handing it over, unknown types included, and drops replays of an id it has seen). Transport
 * commands need video showing, paused or not, and win over the hidden menu: `resume`, `next` and `previous` close it,
 * `pause` makes sure closing it later does not resume, `seek` happens under it.
 *
 * On a channel (loading or playing) `pause`, `resume` and `seek` do nothing (`ignored`, `live`): a channel is never
 * paused. `next` and `previous` zap to the channel after / before it on Home, as CH+/CH− do ([Action.Zap]), also from
 * the channel's error screen.
 *
 * Every command ends in exactly one result for the server: a [Action.Report] last when it is known at once, else
 * [Action.Play] (reports once its playback runs or fails), [Action.Step] or [Action.Zap] (report whether they
 * switched) or [Action.Update] (reports what became of the update).
 */
object CommandPlan {
    sealed interface Action {
        /**
         * Plays [episodeId] from [positionMs], or under the normal resume rules when null; or, without [episodeId],
         * the channel [itemId] at its live edge. [itemId]'s tile (if on Home) as the hint and the focus.
         */
        data class Play(val itemId: String?, val episodeId: String?, val positionMs: Long? = null) : Action {
            val ref: PlayableRef get() = RemoteCommand.Play(itemId, episodeId, positionMs).ref
        }
        data object Exit : Action
        data object Pause : Action
        data object Resume : Action
        data class Seek(val command: RemoteCommand.Seek) : Action

        /** The next (+1) or previous (−1) episode, as CH+/CH−. */
        data class Step(val direction: Int) : Action

        /** The next (+1) or previous (−1) channel on Home, as CH+/CH− while a channel plays. */
        data class Zap(val direction: Int) : Action

        /** Closes the hidden menu; [resume]: resumes playback if opening it paused it. */
        data class CloseMenu(val resume: Boolean) : Action

        /** Closing the hidden menu later (open now or not) does not resume playback. */
        data object StayPausedAfterMenu : Action
        data class ShowMessage(val message: RemoteCommand.Message) : Action

        /** The command's result, known now. */
        data class Report(val result: CommandResult) : Action

        /** The owner's `update`: [io.github.mickeiik.izle.update.UpdatePlan] decides (and reports). */
        data class Update(val command: RemoteCommand.Update) : Action
    }

    private val done = Action.Report(CommandResult.Done)

    /**
     * The actions for [command] on [screen], with the player in [phase] and the hidden menu open or not, in order.
     * [live]: the player's playback is a channel.
     */
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
            is RemoteCommand.Play -> listOf(Action.Play(command.itemId, command.episodeId, command.positionMs))
            RemoteCommand.Stop -> if (screen == Screen.Player) listOf(Action.Exit, done) else notInPlayer
            RemoteCommand.Pause -> if (channel) noPause else if (video) listOf(Action.StayPausedAfterMenu, Action.Pause, done) else notInPlayer
            RemoteCommand.Resume -> if (channel) noPause else if (video) closingMenu(resume = false) + Action.Resume + done else notInPlayer
            is RemoteCommand.Seek -> if (channel) noPause else if (video) listOf(Action.Seek(command), done) else notInPlayer
            RemoteCommand.Next -> when {
                zaps -> closingMenu(resume = true) + Action.Zap(1)
                video -> closingMenu(resume = true) + Action.Step(1)
                else -> notInPlayer
            }
            RemoteCommand.Previous -> when {
                zaps -> closingMenu(resume = true) + Action.Zap(-1)
                video -> closingMenu(resume = true) + Action.Step(-1)
                else -> notInPlayer
            }
            is RemoteCommand.Message -> listOf(Action.ShowMessage(command), done)
            is RemoteCommand.Update -> listOf(Action.Update(command))
            // A newer server's command, or an unusable one: acknowledged, nothing else.
            is RemoteCommand.Ignored -> listOf(Action.Report(CommandResult.ignored(CommandResult.UNKNOWN_TYPE)))
        }
    }
}
