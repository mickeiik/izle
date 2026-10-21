package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.NextEpisode
import io.github.mickeiik.izle.domain.PlayableRef
import io.github.mickeiik.izle.domain.RemoteCommand
import io.github.mickeiik.izle.player.PlayerPhase
import io.github.mickeiik.izle.ui.CommandPlan.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class CommandPlanTest {
    private val play = RemoteCommand.Play(itemId = "show", episodeId = "show.e2")
    private val seek = RemoteCommand.Seek(deltaMs = 60_000, positionMs = null)
    private val message = RemoteCommand.Message("Dinner is ready", durationSec = 15)
    private val transport = listOf(RemoteCommand.Pause, RemoteCommand.Resume, seek, RemoteCommand.Next, RemoteCommand.Previous)

    private val done = Action.Report(CommandResult.Done)
    private val notInPlayer = listOf(Action.Report(CommandResult.ignored(CommandResult.NOT_IN_PLAYER)))
    private val notReady = listOf(Action.Report(CommandResult.ignored(CommandResult.NOT_READY)))
    private val unknownType = listOf(Action.Report(CommandResult.ignored(CommandResult.UNKNOWN_TYPE)))

    private val noVideo = listOf(
        PlayerPhase.Idle,
        PlayerPhase.Loading,
        PlayerPhase.UpNext(NextEpisode("show.e3"), secondsLeft = 7),
        PlayerPhase.Finished,
        PlayerPhase.Failed(secondsLeft = 30),
    )

    private val noPause = listOf(Action.Report(CommandResult.ignored(CommandResult.LIVE)))

    private fun onVideo(command: RemoteCommand, menuOpen: Boolean = false, live: Boolean = false) =
        CommandPlan.actions(command, Screen.Player, PlayerPhase.Playing, menuOpen, live)

    @Test
    fun onHomeOnlyPlayAndMessagesAct() {
        for (menuOpen in listOf(false, true)) {
            assertEquals(listOf(Action.Play("show", "show.e2")), CommandPlan.actions(play, Screen.Home, PlayerPhase.Idle, menuOpen))
            assertEquals(listOf(Action.ShowMessage(message), done), CommandPlan.actions(message, Screen.Home, PlayerPhase.Idle, menuOpen))
            for (command in transport + RemoteCommand.Stop) {
                assertEquals("$command", notInPlayer, CommandPlan.actions(command, Screen.Home, PlayerPhase.Idle, menuOpen))
            }
            assertEquals(unknownType, CommandPlan.actions(RemoteCommand.Ignored("play"), Screen.Home, PlayerPhase.Idle, menuOpen))
        }
    }

    @Test
    fun playCarriesItsStartPosition() {
        val fromStart = RemoteCommand.Play("show", "show.e2", positionMs = 0)
        assertEquals(listOf(Action.Play("show", "show.e2", positionMs = 0)), CommandPlan.actions(fromStart, Screen.Home, PlayerPhase.Idle, menuOpen = false))
        val at = RemoteCommand.Play(null, "show.e2", positionMs = 754_000)
        assertEquals(listOf(Action.Play(null, "show.e2", positionMs = 754_000)), onVideo(at, menuOpen = true))
    }

    @Test
    fun withVideoShowingTransportCommandsActAndWinOverTheMenu() {
        assertEquals(listOf(Action.StayPausedAfterMenu, Action.Pause, done), onVideo(RemoteCommand.Pause))
        assertEquals(listOf(Action.StayPausedAfterMenu, Action.Pause, done), onVideo(RemoteCommand.Pause, menuOpen = true))
        assertEquals(listOf(Action.Resume, done), onVideo(RemoteCommand.Resume))
        assertEquals(listOf(Action.CloseMenu(resume = false), Action.Resume, done), onVideo(RemoteCommand.Resume, menuOpen = true))
        assertEquals("seek happens under the menu", listOf(Action.Seek(seek), done), onVideo(seek, menuOpen = true))
        assertEquals(listOf(Action.Seek(seek), done), onVideo(seek))
        // A step reports itself: done, or no_episode at the end of the item.
        assertEquals(listOf(Action.Step(1)), onVideo(RemoteCommand.Next))
        assertEquals(listOf(Action.CloseMenu(resume = true), Action.Step(1)), onVideo(RemoteCommand.Next, menuOpen = true))
        assertEquals(listOf(Action.Step(-1)), onVideo(RemoteCommand.Previous))
        assertEquals(listOf(Action.CloseMenu(resume = true), Action.Step(-1)), onVideo(RemoteCommand.Previous, menuOpen = true))
        assertEquals(listOf(Action.Exit, done), onVideo(RemoteCommand.Stop, menuOpen = true))
        assertEquals(listOf(Action.Play("show", "show.e2")), onVideo(play, menuOpen = true))
        assertEquals(listOf(Action.ShowMessage(message), done), onVideo(message, menuOpen = true))
        assertEquals("an unknown command does nothing", unknownType, onVideo(RemoteCommand.Ignored("launch"), menuOpen = true))
    }

    @Test
    fun aChannelIsNeverPausedOrSoughtAndNextPreviousZap() {
        // Loading counts: CH+ (and the owner's next) zap on while the next channel loads.
        for (phase in listOf(PlayerPhase.Playing, PlayerPhase.Loading)) {
            for (command in listOf(RemoteCommand.Pause, RemoteCommand.Resume, seek)) {
                assertEquals("$command in $phase", noPause, CommandPlan.actions(command, Screen.Player, phase, menuOpen = false, live = true))
            }
            assertEquals(listOf(Action.Zap(1)), CommandPlan.actions(RemoteCommand.Next, Screen.Player, phase, menuOpen = false, live = true))
            assertEquals(listOf(Action.Zap(-1)), CommandPlan.actions(RemoteCommand.Previous, Screen.Player, phase, menuOpen = false, live = true))
            assertEquals(listOf(Action.Exit, done), CommandPlan.actions(RemoteCommand.Stop, Screen.Player, phase, menuOpen = false, live = true))
        }
        // The menu over a channel did not pause it: pause leaves it alone, next and previous close it.
        assertEquals(noPause, onVideo(RemoteCommand.Pause, menuOpen = true, live = true))
        assertEquals(noPause, onVideo(RemoteCommand.Resume, menuOpen = true, live = true))
        assertEquals(listOf(Action.CloseMenu(resume = true), Action.Zap(1)), onVideo(RemoteCommand.Next, menuOpen = true, live = true))
        assertEquals(listOf(Action.Play("show", "show.e2")), onVideo(play, live = true))
        assertEquals(listOf(Action.ShowMessage(message), done), onVideo(message, live = true))
        // Its error screen takes transport commands no more than a show's; Home has no channel playing.
        for (command in transport) {
            assertEquals(notInPlayer, CommandPlan.actions(command, Screen.Player, PlayerPhase.Failed(30), menuOpen = false, live = true))
            assertEquals(notInPlayer, CommandPlan.actions(command, Screen.Home, PlayerPhase.Idle, menuOpen = false, live = true))
        }
    }

    @Test
    fun playWithoutAnEpisodePlaysTheChannel() {
        val channel = RemoteCommand.Play("news-24", episodeId = null)
        assertEquals(listOf(Action.Play("news-24", null)), CommandPlan.actions(channel, Screen.Home, PlayerPhase.Idle, menuOpen = false))
        assertEquals(listOf(Action.Play("news-24", null)), onVideo(channel, menuOpen = true))
        assertEquals(PlayableRef.Channel("news-24"), Action.Play("news-24", null).ref)
        assertEquals(PlayableRef.Episode("show.e2"), Action.Play("show", "show.e2", positionMs = 0).ref)
    }

    @Test
    fun inThePlayerWithoutVideoOnlyStopPlayAndMessagesAct() {
        for (phase in noVideo) {
            for (command in transport) {
                assertEquals("$command in $phase", notInPlayer, CommandPlan.actions(command, Screen.Player, phase, menuOpen = false))
            }
            assertEquals(listOf(Action.Exit, done), CommandPlan.actions(RemoteCommand.Stop, Screen.Player, phase, menuOpen = false))
            assertEquals(listOf(Action.Play("show", "show.e2")), CommandPlan.actions(play, Screen.Player, phase, menuOpen = false))
            assertEquals(listOf(Action.ShowMessage(message), done), CommandPlan.actions(message, Screen.Player, phase, menuOpen = false))
        }
    }

    @Test
    fun updateIsLeftToTheUpdatePlanOnHomeAndInThePlayer() {
        val update = RemoteCommand.Update(versionCode = 300)
        for (menuOpen in listOf(false, true)) {
            assertEquals(listOf(Action.Update(update)), CommandPlan.actions(update, Screen.Home, PlayerPhase.Idle, menuOpen))
            // Which answers `busy`: never during playback.
            assertEquals(listOf(Action.Update(update)), CommandPlan.actions(update, Screen.Player, PlayerPhase.Playing, menuOpen))
        }
        assertEquals(notReady, CommandPlan.actions(update, Screen.Setup(canGoBack = true), PlayerPhase.Idle, menuOpen = false))
        // The update screen takes no other command.
        val updating = Screen.Update(UpdateUi("0.3.0", UpdatePhase.Installing))
        assertEquals(listOf(Action.Update(update)), CommandPlan.actions(update, updating, PlayerPhase.Idle, menuOpen = false))
        assertEquals(notReady, CommandPlan.actions(play, updating, PlayerPhase.Idle, menuOpen = false))
    }

    @Test
    fun otherScreensIgnoreEveryCommandAsNotReady() {
        val everything = transport + listOf(play, message, RemoteCommand.Stop, RemoteCommand.Update(null))
        for (screen in listOf(Screen.Starting, Screen.Setup(canGoBack = false), Screen.Setup(canGoBack = true), Screen.Pairing)) {
            for (command in everything) {
                assertEquals("$command on $screen", notReady, CommandPlan.actions(command, screen, PlayerPhase.Idle, menuOpen = false))
            }
            assertEquals("unknown wherever it arrives", unknownType, CommandPlan.actions(RemoteCommand.Ignored("launch"), screen, PlayerPhase.Idle, menuOpen = false))
        }
    }

    @Test
    fun everyCommandEndsInExactlyOneResult() {
        // A Report, a Play or a Step: one of them, once, and last.
        val everything = transport + listOf(play, message, RemoteCommand.Stop, RemoteCommand.Ignored("launch"), RemoteCommand.Update(300))
        val updating = Screen.Update(UpdateUi("0.3.0", UpdatePhase.Prompt(60)))
        val screens = listOf(Screen.Starting, Screen.Setup(canGoBack = true), Screen.Pairing, Screen.Home, Screen.Player, updating)
        val bools = listOf(false, true)
        for (screen in screens) for (phase in noVideo + PlayerPhase.Playing) for (menuOpen in bools) for (live in bools) for (command in everything) {
            val actions = CommandPlan.actions(command, screen, phase, menuOpen, live)
            val answering = actions.filter { it is Action.Report || it is Action.Play || it is Action.Step || it is Action.Zap || it is Action.Update }
            assertEquals("$command on $screen in $phase (live $live)", listOf(actions.last()), answering)
        }
    }
}
