package io.github.mickeiik.izle.companion.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.tv.UNREACHABLE
import io.github.mickeiik.izle.data.api.AdminDevice
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.NowPlaying
import io.github.mickeiik.izle.data.api.StatusDevice
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

/** The TV list's words: the code, the minutes left, the server's default name, each TV's state, refusals. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PairingTextTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources

    @Test
    fun codesAndNames() {
        assertEquals("483 920", formatCode("483920"))
        assertEquals(8, minutesLeft(expiresAtMs = 450_000, nowMs = 0))
        assertEquals(1, minutesLeft(expiresAtMs = 1_000, nowMs = 0))
        assertEquals(0, minutesLeft(expiresAtMs = 1_000, nowMs = 1_000))
        assertEquals("TV", defaultTvName(listOf("Salon")))
        assertEquals("TV 2", defaultTvName(listOf("Salon", "tv ")))
        assertEquals("TV 4", defaultTvName(listOf("TV", "TV 2", "TV 3")))
    }

    @Test
    fun aTvsState() {
        val now = 1_793_099_100_000L // 2026-10-27T11:05:00Z
        val salon = AdminDevice("tv-1", "Salon", online = true)
        val playing = StatusDevice("tv-1", "Salon", online = true, nowPlaying = NowPlaying("cam", "series", itemTitle = "Caminandes"))
        assertEquals("Online · playing Caminandes", tvStateText(res, salon, playing, now))
        assertEquals("Online", tvStateText(res, salon, null, now))
        val seen = StatusDevice("tv-1", "Salon", online = false, lastSeenAt = "2026-10-27T09:05:00.000Z")
        assertEquals("Offline · seen 2 hours ago", tvStateText(res, salon, seen, now))
        assertEquals("Not seen yet", tvStateText(res, salon.copy(online = false), null, now))
    }

    @Test
    fun refusalsInWords() {
        assertEquals("No TV shows this code (it may have expired).", pairingErrorText(res, ApiException(404, "unknown_code")))
        assertEquals("This code was approved already.", pairingErrorText(res, ApiException(409, "already_approved")))
        assertEquals("That TV does not exist any more.", pairingErrorText(res, ApiException(404, "unknown_device")))
        assertEquals("The server refused (http_500).", pairingErrorText(res, ApiException(500, "http_500")))
        assertEquals(UNREACHABLE, pairingErrorText(res, IOException("down")))
    }
}
