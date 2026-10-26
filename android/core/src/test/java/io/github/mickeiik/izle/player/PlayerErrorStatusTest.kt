package io.github.mickeiik.izle.player

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

/** [httpStatus] on Media3's real exceptions, whose [DataSpec] needs an `android.net.Uri`: hence Robolectric. */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PlayerErrorStatusTest {
    private fun httpAnswer(status: Int) = HttpDataSource.InvalidResponseCodeException(
        status, null, null, emptyMap(), DataSpec(Uri.parse("https://media.test/seg.ts")), ByteArray(0),
    )

    private fun playerError(cause: Throwable?) = PlaybackException("Source error", cause, PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)

    @Test
    fun theStatusComesFromTheHttpAnswerInTheCauseChain() {
        assertEquals(403, playerError(httpAnswer(403)).httpStatus())
        assertEquals(410, playerError(IOException("wrapped", httpAnswer(410))).httpStatus())
        // Without an HTTP answer: no status.
        assertNull(playerError(IOException("timeout")).httpStatus())
        assertNull(playerError(null).httpStatus())
    }
}
