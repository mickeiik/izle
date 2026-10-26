package io.github.mickeiik.izle.player

import android.Manifest
import android.app.Application
import androidx.media3.common.C
import androidx.test.core.app.ApplicationProvider
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager

/** The real adapter's decoder lifecycle needs Android services; transport is answered in memory. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExoMediaEngineTest {
    private val http = OkHttpClient.Builder().addInterceptor { chain ->
        Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
            .code(404).message("fixture").body(ByteArray(0).toResponseBody()).build()
    }.build()
    private val media = MediaSpec("http://media.test/one", "mp4", emptyList(), "episode", live = false)

    @After
    fun tearDown() {
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    @Test
    fun audioOnlyDisablesVideoAndKeepsTheNetworkAwake() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).grantPermissions(Manifest.permission.WAKE_LOCK) // the companion app's manifest asks for it
        val engine = ExoMediaEngine(app, http, "izle-test", capVideoTo720p = false, audioOnly = true)
        try {
            engine.applyPreferences("de", null)
            engine.load(media, 0)
            val first = engine.surface!!
            assertTrue(C.TRACK_TYPE_VIDEO in first.trackSelectionParameters.disabledTrackTypes)
            assertEquals(listOf("de"), first.trackSelectionParameters.preferredAudioLanguages)
            // The wake mode: the player creates its wake lock (on its own thread) only when a wake mode is set.
            val deadline = System.currentTimeMillis() + 5_000
            while (ShadowPowerManager.getLatestWakeLock() == null && System.currentTimeMillis() < deadline) Thread.sleep(10)
            assertEquals("ExoPlayer:WakeLockManager", shadowOf(ShadowPowerManager.getLatestWakeLock()).tag)
            // Also on a decoder created later.
            engine.release()
            engine.applyPreferences("en", null)
            engine.load(media, 0)
            assertTrue(C.TRACK_TYPE_VIDEO in engine.surface!!.trackSelectionParameters.disabledTrackTypes)
        } finally {
            engine.release()
        }
    }

    @Test
    fun playbackRateIsThePlayersSpeed() {
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), http, "izle-test", capVideoTo720p = false)
        try {
            assertEquals("nominal without a decoder", 1f, engine.playbackRate)
            engine.load(media, 0)
            assertEquals(1f, engine.playbackRate)
            engine.playbackRate = 1.05f
            assertEquals(1.05f, engine.surface!!.playbackParameters.speed)
            assertEquals(1.05f, engine.playbackRate)
            engine.playbackRate = 0.98f
            assertEquals(0.98f, engine.playbackRate)
        } finally {
            engine.release()
        }
    }

    @Test
    fun theDecoderIsLazyReusedAndRecreatedWithPreferencesAfterRelease() {
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), http, "izle-test", capVideoTo720p = true)
        try {
            engine.applyPreferences("pt-BR", "tr")
            assertNull(engine.surface)
            engine.load(media, 55_000)
            val first = engine.surface!!
            assertEquals(55_000L, engine.positionMs)
            assertEquals(listOf("pt-br", "pt"), first.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(listOf("tr"), first.trackSelectionParameters.preferredTextLanguages)
            assertFalse(C.TRACK_TYPE_TEXT in first.trackSelectionParameters.disabledTrackTypes)
            assertEquals(1280, first.trackSelectionParameters.maxVideoWidth)
            assertEquals(720, first.trackSelectionParameters.maxVideoHeight)
            assertFalse("the TV shows the picture", C.TRACK_TYPE_VIDEO in first.trackSelectionParameters.disabledTrackTypes)
            engine.load(media, 80_000)
            assertSame(first, engine.surface)
            engine.release()
            assertNull(engine.surface)
            engine.applyPreferences("en", null)
            engine.load(media, 90_000)
            assertNotSame(first, engine.surface)
            assertEquals(90_000L, engine.positionMs)
            assertEquals(listOf("en"), engine.surface!!.trackSelectionParameters.preferredAudioLanguages)
            assertTrue(C.TRACK_TYPE_TEXT in engine.surface!!.trackSelectionParameters.disabledTrackTypes)
        } finally {
            engine.release()
        }
    }
}
