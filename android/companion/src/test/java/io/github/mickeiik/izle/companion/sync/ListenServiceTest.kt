package io.github.mickeiik.izle.companion.sync

import android.app.Notification
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.data.api.CompanionResolveRequest
import io.github.mickeiik.izle.data.api.CompanionResolveResponse
import io.github.mickeiik.izle.data.api.CompanionResponse
import io.github.mickeiik.izle.data.api.LinkTiming
import io.github.mickeiik.izle.data.api.NowResponse
import io.github.mickeiik.izle.player.FakeMediaEngine
import kotlinx.coroutines.awaitCancellation
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The foreground service follows the graph's session: its notification, its Stop action, and its end. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ListenServiceTest {
    private val app: CompanionApp = ApplicationProvider.getApplicationContext()
    private val session: ListenSession = app.graph
        .apply { newSession = { _, scope -> ListenSession(NeverAnswers, FakeMediaEngine(), scope, { it }) } }
        .session("http://127.0.0.1:9/".toHttpUrl(), "izat_test")

    private val target = ListenTarget("tv-1", "show.e1", "dub", "fr", "Show", "Pilot")

    @After
    fun tearDown() {
        app.graph.releaseSession()
    }

    @Test
    fun itRunsInTheForegroundWithANotificationAndStopsWhenListeningEnds() {
        session.start(target, LinkTiming(), 0)
        val service = Robolectric.buildService(ListenService::class.java, Intent(app, ListenService::class.java)).create().startCommand(0, 1).get()
        idle()
        val shadow = shadowOf(service)
        val notification = shadow.lastForegroundNotification
        assertNotNull(notification)
        assertEquals(ListenService.NOTIFICATION_ID, shadow.lastForegroundNotificationId)
        assertEquals("Show", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertTrue(notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString().startsWith("Pilot · "))
        assertEquals(ListenService.CHANNEL_ID, notification.channelId)
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(Notification.CATEGORY_TRANSPORT, notification.category)
        val stop = notification.actions.single()
        assertEquals("Stop", stop.title.toString())
        val stopIntent = shadowOf(stop.actionIntent)
        assertTrue(stopIntent.isServiceIntent)
        assertEquals(ListenService.ACTION_STOP, stopIntent.savedIntent.action)
        assertTrue(shadowOf(notification.contentIntent).isActivityIntent)
        assertFalse(shadow.isStoppedBySelf)

        session.stop()
        idle()
        assertTrue(shadow.isForegroundStopped)
        assertTrue(shadow.isStoppedBySelf)
    }

    @Test
    fun theStopActionStopsTheSession() {
        session.start(target, LinkTiming(), 0)
        val controller = Robolectric.buildService(ListenService::class.java, Intent(app, ListenService::class.java)).create().startCommand(0, 1)
        idle()
        controller.withIntent(Intent(app, ListenService::class.java).setAction(ListenService.ACTION_STOP)).startCommand(0, 2)
        assertEquals(ListenPhase.Idle, session.state.value.phase)
        assertEquals(EndReason.Stopped, session.state.value.ended)
        idle()
        assertTrue(shadowOf(controller.get()).isStoppedBySelf)
    }

    @Test
    fun withNothingPlayingItStopsAtOnce() {
        val service = Robolectric.buildService(ListenService::class.java, Intent(app, ListenService::class.java)).create().startCommand(0, 1).get()
        val shadow = shadowOf(service)
        assertTrue(shadow.isForegroundStopped)
        assertTrue(shadow.isStoppedBySelf)
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private object NeverAnswers : CompanionApi {
        override suspend fun now(deviceId: String, seq: Long?, waitSec: Int): NowResponse = awaitCancellation()
        override suspend fun resolve(deviceId: String, request: CompanionResolveRequest): CompanionResolveResponse = awaitCancellation()
        override suspend fun companion(deviceId: String): CompanionResponse = awaitCancellation()
    }
}
