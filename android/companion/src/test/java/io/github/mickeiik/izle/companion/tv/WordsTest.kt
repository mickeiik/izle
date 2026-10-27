package io.github.mickeiik.izle.companion.tv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The words the tabs share: a clock, an episode's name, how long ago. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WordsTest {
    private val res = ApplicationProvider.getApplicationContext<Context>().resources

    @Test
    fun clockAndEpisodeNames() {
        assertEquals("0:00", formatClock(0))
        assertEquals("0:00", formatClock(-5_000))
        assertEquals("12:04", formatClock(724_900))
        assertEquals("1:02:03", formatClock(3_723_000))
        assertEquals("S1 · E5 — Rain", episodeName(1, 5, null, "Rain"))
        assertEquals("S1 · E5", episodeName(1, 5, null, null))
        assertEquals("Episode 5", episodeName(null, 5, null, null))
        assertEquals("Special", episodeName(1, 5, "Special", null))
        assertEquals("Pilot", episodeName(null, null, null, "Pilot"))
    }

    @Test
    fun howLongAgo() {
        val now = 1_800_000_000_000L
        assertEquals("just now", timeAgo(res, now - 30_000, now))
        assertEquals("5 minutes ago", timeAgo(res, now - 5 * 60_000, now))
    }
}
