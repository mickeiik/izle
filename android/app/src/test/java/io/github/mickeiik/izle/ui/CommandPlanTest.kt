package io.github.mickeiik.izle.ui

import io.github.mickeiik.izle.data.api.NextEpisode
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

    private val noVideo = listOf(
        PlayerPhase.Idle,
        PlayerPhase.Loading,
        PlayerPhase.UpNext(NextEpisode("show.e3"), secondsLeft = 7),
        PlayerPhase.Finished,
        PlayerPhase.Failed(secondsLeft = 30),
    )

    private fun onVideo(command: RemoteCommand, menuOpen: Boolean = false) =
        CommandPlan.actions(command, Screen.Player, PlayerPhase.Playing, menuOpen)

    @Test
    fun onHomeOnlyPlayAndMessagesAct() {
        for (menuOpen in listOf(false, true)) {
            assertEquals(listOf(Action.Play("show", "show.e2")), CommandPlan.actions(play, Screen.Home, PlayerPhase.Idle, menuOpen))
            assertEquals(listOf(Action.ShowMessage(message)), CommandPlan.actions(message, Screen.Home, PlayerPhase.Idle, menuOpen))
            for (command in transport + RemoteCommand.Stop + RemoteCommand.Ignored("play")) {
                assertEquals("$command", emptyList<Action>(), CommandPlan.actions(command, Screen.Home, PlayerPhase.Idle, menuOpen))
            }
        }
    }

    @Test
    fun withVideoShowingTransportCommandsActAndWinOverTheMenu() {
        assertEquals(listOf(Action.StayPausedAfterMenu, Action.Pause), onVideo(RemoteCommand.Pause))
        assertEquals(listOf(Action.StayPausedAfterMenu, Action.Pause), onVideo(RemoteCommand.Pause, menuOpen = true))
        assertEquals(listOf(Action.Resume), onVideo(RemoteCommand.Resume))
        assertEquals(listOf(Action.CloseMenu(resume = false), Action.Resume), onVideo(RemoteCommand.Resume, menuOpen = true))
        assertEquals("seek happens under the menu", listOf(Action.Seek(seek)), onVideo(seek, menuOpen = true))
        assertEquals(listOf(Action.Seek(seek)), onVideo(seek))
        assertEquals(listOf(Action.Step(1)), onVideo(RemoteCommand.Next))
        assertEquals(listOf(Action.CloseMenu(resume = true), Action.Step(1)), onVideo(RemoteCommand.Next, menuOpen = true))
        assertEquals(listOf(Action.Step(-1)), onVideo(RemoteCommand.Previous))
        assertEquals(listOf(Action.CloseMenu(resume = true), Action.Step(-1)), onVideo(RemoteCommand.Previous, menuOpen = true))
        assertEquals(listOf(Action.Exit), onVideo(RemoteCommand.Stop, menuOpen = true))
        assertEquals(listOf(Action.Play("show", "show.e2")), onVideo(play, menuOpen = true))
        assertEquals(listOf(Action.ShowMessage(message)), onVideo(message, menuOpen = true))
        assertEquals("an unknown command does nothing", emptyList<Action>(), onVideo(RemoteCommand.Ignored("launch"), menuOpen = true))
    }

    @Test
    fun inThePlayerWithoutVideoOnlyStopPlayAndMessagesAct() {
        for (phase in noVideo) {
            for (command in transport) {
                assertEquals("$command in $phase", emptyList<Action>(), CommandPlan.actions(command, Screen.Player, phase, menuOpen = false))
            }
            assertEquals(listOf(Action.Exit), CommandPlan.actions(RemoteCommand.Stop, Screen.Player, phase, menuOpen = false))
            assertEquals(listOf(Action.Play("show", "show.e2")), CommandPlan.actions(play, Screen.Player, phase, menuOpen = false))
            assertEquals(listOf(Action.ShowMessage(message)), CommandPlan.actions(message, Screen.Player, phase, menuOpen = false))
        }
    }

    @Test
    fun otherScreensIgnoreEveryCommand() {
        val everything = transport + listOf(play, message, RemoteCommand.Stop, RemoteCommand.Ignored("launch"))
        for (screen in listOf(Screen.Starting, Screen.Setup(canGoBack = false), Screen.Setup(canGoBack = true), Screen.Pairing)) {
            for (command in everything) {
                assertEquals("$command on $screen", emptyList<Action>(), CommandPlan.actions(command, screen, PlayerPhase.Idle, menuOpen = false))
            }
        }
    }
}
