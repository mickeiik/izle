package io.github.mickeiik.izle.companion.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CompanionStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var scope: CoroutineScope
    private lateinit var store: CompanionStore

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        store = newStore()
    }

    @After
    fun tearDown() = scope.cancel()

    private fun newStore() = CompanionStore(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "companion.preferences_pb") })

    @Test
    fun startsUnpaired() = runBlocking {
        assertEquals(CompanionSettings(), store.current())
        assertFalse(store.current().isPaired)
    }

    @Test
    fun theSameServerKeepsTheTvAndAnotherForgetsIt() = runBlocking {
        store.savePairing("http://10.0.2.2:8787/", "izat_one")
        store.setTv("abcdefabcdef")
        assertTrue(store.current().isPaired)
        assertEquals("abcdefabcdef", store.current().tvId)

        store.savePairing("http://10.0.2.2:8787/", "izat_two")
        assertEquals("a new token for the same server", "izat_two", store.current().token)
        assertEquals("abcdefabcdef", store.current().tvId)

        store.savePairing("http://192.168.1.10:8787/", "izat_three")
        assertTrue(store.current().isPaired)
        assertNull("another server's TV", store.current().tvId)
    }

    @Test
    fun forgettingThePairingForgetsServerTokenAndTvButKeepsTheNudge() = runBlocking {
        store.savePairing("http://10.0.2.2:8787/", "izat_one")
        store.setTv("abcdefabcdef")
        store.setNudgeMs(-150)
        store.forgetPairing()
        assertEquals(CompanionSettings(nudgeMs = -150), store.current())
        assertFalse(store.current().isPaired)
    }

    @Test
    fun aClaimStoresThePhoneIdAndChoosesTheInvitingTv() = runBlocking {
        store.savePairing("http://10.0.2.2:8787/", "izat_one")
        store.setTv("abcdefabcdef")
        store.savePairing("http://192.168.1.10:8787/", "izph_secret", phoneId = "ph0123456789", tvId = "tv0123456789")
        assertEquals(
            CompanionSettings("http://192.168.1.10:8787/", "izph_secret", "ph0123456789", "tv0123456789"),
            store.current(),
        )
        store.savePairing("http://192.168.1.10:8787/", "izat_typed")
        assertNull("a typed token is no phone", store.current().phoneId)
        assertEquals("the same server keeps its TV", "tv0123456789", store.current().tvId)

        store.savePairing("http://192.168.1.10:8787/", "izph_two", phoneId = "ph9876543210")
        store.forgetPairing()
        assertNull(store.current().phoneId)
        assertFalse(store.current().isPaired)
    }

    @Test
    fun anOlderInstallReadsAsPairedWithoutAPhoneId() = runBlocking {
        // What the companion-scope version stored: the same keys, no phone id.
        val old = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "older.preferences_pb") }
        old.edit { p ->
            p[stringPreferencesKey("server_url")] = "http://10.0.2.2:8787/"
            p[stringPreferencesKey("token")] = "izat_companion"
            p[stringPreferencesKey("tv_id")] = "abcdefabcdef"
        }
        val read = CompanionStore(old).current()
        assertTrue(read.isPaired)
        assertEquals("izat_companion", read.token)
        assertEquals("abcdefabcdef", read.tvId)
        assertNull(read.phoneId)
    }

    @Test
    fun theTvCanBeCleared() = runBlocking {
        store.savePairing("http://10.0.2.2:8787/", "izat_one")
        store.setTv("abcdefabcdef")
        store.setTv(null)
        assertNull(store.current().tvId)
        assertTrue(store.current().isPaired)
    }

    @Test
    fun theNudgePersists() = runBlocking {
        store.setNudgeMs(100)
        assertEquals(100L, store.current().nudgeMs)
        store.setNudgeMs(0)
        assertEquals(0L, store.current().nudgeMs)
        store.setNudgeMs(50)
        // One DataStore per file at a time: the first one's scope must be done before the file is opened again.
        scope.coroutineContext.job.cancelAndJoin()

        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        assertEquals("read back from the file", 50L, newStore().current().nudgeMs)
    }
}
