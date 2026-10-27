package io.github.mickeiik.izle.companion.tv

import io.github.mickeiik.izle.data.api.CommandInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What a command came to, in words: the remote's and a message's snackbars, and Home's Play now. */
class CommandsTest {
    private fun result(type: String, result: String?, reason: String? = null) = CommandInfo(id = 1, type = type, result = result, reason = reason)

    @Test
    fun commandResultsAreSaidOnlyWhenWorthSaying() {
        assertEquals("Salon is offline. It gets this if it connects in the next 2 minutes.", offlineText("Salon"))
        assertEquals("Salon hasn't answered. It may be off or asleep.", noAnswerText("Salon"))
        assertNull("done", commandResultText("Salon", result("next", "done")))
        assertNull("no result yet", commandResultText("Salon", result("next", null)))
        assertEquals("Shown on Salon", commandResultText("Salon", result("message", "done")))
        assertEquals("Nothing is playing on Salon.", commandResultText("Salon", result("pause", "ignored", "not_in_player")))
        assertEquals("No next episode.", commandResultText("Salon", result("next", "ignored", "no_episode")))
        assertEquals("No previous episode.", commandResultText("Salon", result("previous", "ignored", "no_episode")))
        assertEquals("No channel after this one on Home.", commandResultText("Salon", result("next", "ignored", "no_channel")))
        assertEquals("No channel before this one on Home.", commandResultText("Salon", result("previous", "ignored", "no_channel")))
        assertEquals("A channel can't be paused or skipped through.", commandResultText("Salon", result("seek", "ignored", "live")))
        assertEquals("Salon isn't ready (it shows its pairing screen).", commandResultText("Salon", result("stop", "ignored", "not_ready")))
        assertEquals("Salon couldn't do that (the player failed).", commandResultText("Salon", result("next", "failed", "playback_error")))
        assertEquals("unknown reasons in words", "Salon didn't do that (some new thing).", commandResultText("Salon", result("next", "ignored", "some_new_thing")))
        assertEquals("Salon couldn't do that.", commandResultText("Salon", result("next", "failed")))
    }

    @Test
    fun outcomesOfARemotePress() {
        assertEquals(offlineText("Salon"), commandOutcomeText("Salon", CommandOutcome.Queued))
        assertEquals(noAnswerText("Salon"), commandOutcomeText("Salon", CommandOutcome.NoAnswer))
        assertNull(commandOutcomeText("Salon", CommandOutcome.Answered(result("next", "done"))))
        assertEquals("No next episode.", commandOutcomeText("Salon", CommandOutcome.Answered(result("next", "ignored", "no_episode"))))
    }

    @Test
    fun outcomesOfPlayNow() {
        assertEquals("Salon is offline. It gets this if it connects in the next 2 minutes.", playResultText("Salon", "Sintel", CommandOutcome.Queued))
        assertEquals("Sent to Salon.", playResultText("Salon", "Sintel", CommandOutcome.NoAnswer))
        assertEquals("Sintel is playing on Salon.", playResultText("Salon", "Sintel", CommandOutcome.Answered(result("play", "done"))))
        assertEquals("Salon could not play Sintel.", playResultText("Salon", "Sintel", CommandOutcome.Answered(result("play", "failed", "playback_error"))))
        assertEquals(
            "Salon isn't ready (it shows its pairing screen).",
            playResultText("Salon", "Sintel", CommandOutcome.Answered(result("play", "ignored", "not_ready"))),
        )
    }
}
