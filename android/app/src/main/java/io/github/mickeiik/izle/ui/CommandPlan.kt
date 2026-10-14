package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.player.PlayerPhase

/**
 * What the owner's commands do on this TV. They act only on Home and in the player (the repository acknowledges every
 * command right after handing it over, unknown types included, and drops replays of an id it has seen). Transport
 * commands need video showing, paused or not, and win over the hidden menu: `resume`, `next` and `previous` close it,
 * `pause` makes sure closing it later does not resume, `seek` happens under it.
 */
object CommandPlan {
    sealed interface Action {
        /** Plays [episodeId] under the normal resume rules, [itemId]'s tile (if on Home) as the hint and the focus. */
        data class Play(val itemId: String?, val episodeId: String) : Action

        /** Leaves the player for Home, as Back does. */
        data object Exit : Action
        data object Pause : Action
        data object Resume : Action
        data class Seek(val command: RemoteCommand.Seek) : Action

        /** The next (+1) or previous (−1) episode, as CH+/CH−. */
        data class Step(val direction: Int) : Action

        /** Closes the hidden menu; [resume]: resumes playback if opening it paused it. */
        data class CloseMenu(val resume: Boolean) : Action

        /** Closing the hidden menu later (open now or not) does not resume playback. */
        data object StayPausedAfterMenu : Action

        /** The owner's banner. */
        data class ShowMessage(val message: RemoteCommand.Message) : Action
    }

    /** The actions for [command] on [screen], with the player in [phase] and the hidden menu open or not, in order. */
    fun actions(command: RemoteCommand, screen: Screen, phase: PlayerPhase, menuOpen: Boolean): List<Action> {
        if (screen != Screen.Home && screen != Screen.Player) return emptyList()
        val video = screen == Screen.Player && phase == PlayerPhase.Playing
        fun closingMenu(resume: Boolean) = if (menuOpen) listOf(Action.CloseMenu(resume)) else emptyList()
        return when (command) {
            is RemoteCommand.Play -> listOf(Action.Play(command.itemId, command.episodeId))
            RemoteCommand.Stop -> if (screen == Screen.Player) listOf(Action.Exit) else emptyList()
            RemoteCommand.Pause -> if (video) listOf(Action.StayPausedAfterMenu, Action.Pause) else emptyList()
            RemoteCommand.Resume -> if (video) closingMenu(resume = false) + Action.Resume else emptyList()
            is RemoteCommand.Seek -> if (video) listOf(Action.Seek(command)) else emptyList()
            RemoteCommand.Next -> if (video) closingMenu(resume = true) + Action.Step(1) else emptyList()
            RemoteCommand.Previous -> if (video) closingMenu(resume = true) + Action.Step(-1) else emptyList()
            is RemoteCommand.Message -> listOf(Action.ShowMessage(command))
            is RemoteCommand.Ignored -> emptyList() // a newer server's command, or an unusable one: acknowledged, nothing else
        }
    }
}
