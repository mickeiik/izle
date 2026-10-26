package io.github.mickeiik.izle.player

import androidx.media3.common.C
import androidx.test.core.app.ApplicationProvider
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The real adapter's decoder lifecycle needs Android services; transport is answered in memory. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExoMediaEngineTest {
    @Test
    fun theDecoderIsLazyReusedAndRecreatedWithPreferencesAfterRelease() {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
                .code(404).message("fixture").body(ByteArray(0).toResponseBody()).build()
        }.build()
        val engine = ExoMediaEngine(ApplicationProvider.getApplicationContext(), http, "izle-test", capVideoTo720p = true)
        try {
            engine.applyPreferences("pt-BR", "tr")
            assertNull(engine.surface)
            val media = MediaSpec("http://media.test/one", "mp4", emptyList(), "episode", live = false)
            engine.load(media, 55_000)
            val first = engine.surface!!
            assertEquals(55_000L, engine.positionMs)
            assertEquals(listOf("pt-br", "pt"), first.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(listOf("tr"), first.trackSelectionParameters.preferredTextLanguages)
            assertFalse(C.TRACK_TYPE_TEXT in first.trackSelectionParameters.disabledTrackTypes)
            assertEquals(1280, first.trackSelectionParameters.maxVideoWidth)
            assertEquals(720, first.trackSelectionParameters.maxVideoHeight)
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
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }
}
