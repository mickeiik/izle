package io.github.mickeiik.izle.domain

import io.github.mickeiik.izle.data.api.ServerEvent
import org.junit.Assert.assertEquals
import org.junit.Test

/** Owner commands as they arrive on the event stream (`event: command`), decoded into what the TV does. */
class RemoteCommandTest {
    private fun command(data: String): RemoteCommand = RemoteCommand.of(ServerEvent.parse("command", data) as ServerEvent.Command)

    @Test
    fun playbackCommandsWithoutPayload() {
        assertEquals(RemoteCommand.Pause, command("""{"id":1,"type":"pause","payload":{}}"""))
        assertEquals(RemoteCommand.Resume, command("""{"id":2,"type":"resume","payload":{}}"""))
        assertEquals(RemoteCommand.Next, command("""{"id":3,"type":"next","payload":{}}"""))
        assertEquals(RemoteCommand.Previous, command("""{"id":4,"type":"previous"}"""))
        assertEquals(RemoteCommand.Stop, command("""{"id":5,"type":"stop","payload":{}}"""))
        assertEquals(RemoteCommand.Play("show", "show.e2"), command("""{"id":6,"type":"play","payload":{"itemId":"show","episodeId":"show.e2"}}"""))
    }

    @Test
    fun playMayStartAtAPosition() {
        fun play(payload: String) = command("""{"id":30,"type":"play","payload":{"itemId":"show","episodeId":"show.e2"$payload}}""")
        assertEquals(RemoteCommand.Play("show", "show.e2", positionMs = 754_000), play(""","positionMs":754000"""))
        assertEquals("0 starts over", RemoteCommand.Play("show", "show.e2", positionMs = 0), play(""","positionMs":0"""))
        assertEquals("without one: the saved position", RemoteCommand.Play("show", "show.e2", positionMs = null), play(""))
        assertEquals(RemoteCommand.Play("show", "show.e2", positionMs = null), play(""","positionMs":-5"""))
        assertEquals(RemoteCommand.Play("show", "show.e2", positionMs = null), play(""","positionMs":"start""""))
        assertEquals(RemoteCommand.Play(null, "show.e2", positionMs = 5), command("""{"id":31,"type":"play","payload":{"episodeId":"show.e2","positionMs":5}}"""))
    }

    @Test
    fun seekIsRelativeOrAbsolute() {
        assertEquals(RemoteCommand.Seek(deltaMs = -30_000, positionMs = null), command("""{"id":7,"type":"seek","payload":{"deltaMs":-30000}}"""))
        assertEquals(RemoteCommand.Seek(deltaMs = null, positionMs = 600_000), command("""{"id":8,"type":"seek","payload":{"positionMs":600000}}"""))
        assertEquals(RemoteCommand.Seek(deltaMs = null, positionMs = 5), command("""{"id":9,"type":"seek","payload":{"deltaMs":1,"positionMs":5}}"""))
        assertEquals(RemoteCommand.Ignored("seek"), command("""{"id":10,"type":"seek","payload":{}}"""))
        assertEquals(RemoteCommand.Ignored("seek"), command("""{"id":11,"type":"seek","payload":{"deltaMs":"soon"}}"""))
    }

    @Test
    fun seekTargetsAreClampedToTheEpisode() {
        val back = RemoteCommand.Seek(deltaMs = -30_000, positionMs = null)
        assertEquals(70_000L, back.targetMs(currentMs = 100_000, durationMs = 600_000))
        assertEquals(0L, back.targetMs(currentMs = 10_000, durationMs = 600_000))
        val forward = RemoteCommand.Seek(deltaMs = 60_000, positionMs = null)
        assertEquals(600_000L, forward.targetMs(currentMs = 590_000, durationMs = 600_000))
        assertEquals(650_000L, forward.targetMs(currentMs = 590_000, durationMs = null))
        assertEquals(600_000L, RemoteCommand.Seek(null, 900_000).targetMs(currentMs = 0, durationMs = 600_000))
        assertEquals(0L, RemoteCommand.Seek(null, -1).targetMs(currentMs = 5_000, durationMs = 600_000))
    }

    @Test
    fun messagesAreTrimmedAndTheirDurationClamped() {
        assertEquals(RemoteCommand.Message("Dinner is ready", 15), command("""{"id":12,"type":"message","payload":{"text":" Dinner is ready ","durationSec":15}}"""))
        assertEquals(RemoteCommand.Message("x", 3), command("""{"id":13,"type":"message","payload":{"text":"x","durationSec":1}}"""))
        assertEquals(RemoteCommand.Message("x", 120), command("""{"id":14,"type":"message","payload":{"text":"x","durationSec":9999}}"""))
        assertEquals(RemoteCommand.Message("x", 15), command("""{"id":15,"type":"message","payload":{"text":"x"}}"""))
        val long = command("""{"id":16,"type":"message","payload":{"text":"${"a".repeat(300)}","durationSec":5}}""") as RemoteCommand.Message
        assertEquals(200, long.text.length)
        assertEquals(RemoteCommand.Ignored("message"), command("""{"id":17,"type":"message","payload":{"text":"   ","durationSec":5}}"""))
    }

    @Test
    fun unknownTypesAndOddPayloadsStillArriveToBeAcknowledged() {
        // A command must parse whatever its payload, or it would never be acknowledged and replay for two minutes.
        assertEquals(ServerEvent.Command(20, "dance"), ServerEvent.parse("command", """{"id":20,"type":"dance","payload":{"style":"tango","speed":[1,2]}}"""))
        assertEquals(ServerEvent.Command(21, "volume"), ServerEvent.parse("command", """{"id":21,"type":"volume","payload":7}"""))
        assertEquals(ServerEvent.Command(22, "reboot"), ServerEvent.parse("command", """{"id":22,"type":"reboot","payload":null}"""))
        assertEquals(ServerEvent.Command(23, "play", itemId = null, episodeId = null), ServerEvent.parse("command", """{"id":23,"type":"play","payload":{"episodeId":42}}"""))
        assertEquals(RemoteCommand.Ignored("dance"), command("""{"id":20,"type":"dance","payload":{"style":"tango"}}"""))
        assertEquals(RemoteCommand.Ignored("play"), command("""{"id":23,"type":"play","payload":{"episodeId":42}}"""))
    }
}
