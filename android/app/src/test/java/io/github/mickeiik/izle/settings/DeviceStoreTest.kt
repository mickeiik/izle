package io.github.mickeiik.izle.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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

class DeviceStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var scope: CoroutineScope
    private lateinit var store: DeviceStore

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        store = DeviceStore(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "izle.preferences_pb") })
    }

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun pairingIsKeptForTheSameServerOnly() = runBlocking {
        store.setServer("http://10.0.2.2:8787/")
        store.savePairing("abcdefabcdef", "token")
        store.saveCachedState("{}")
        assertTrue(store.current().isPaired)

        store.setServer("http://10.0.2.2:8787/")
        assertEquals("token", store.current().deviceToken)
        assertEquals("{}", store.cachedState())

        store.setServer("http://192.168.1.10:8787/")
        val s = store.current()
        assertFalse(s.isPaired)
        assertNull(s.deviceId)
        assertNull(store.cachedState())
    }

    @Test
    fun forgettingThePairingKeepsTheServer() = runBlocking {
        store.setServer("http://10.0.2.2:8787/")
        store.savePairing("abcdefabcdef", "token")
        store.forgetPairing()
        assertEquals("http://10.0.2.2:8787/", store.current().serverUrl)
        assertFalse(store.current().isPaired)
    }

    @Test
    fun theShowPlayedLastBelongsToThisPairing() = runBlocking {
        store.setServer("http://10.0.2.2:8787/")
        store.savePairing("abcdefabcdef", "token")
        assertNull(store.current().lastPlayedItemId)
        store.setLastPlayedItem("caminandes")
        store.setLastPlayedItem("sintel")
        assertEquals("sintel", store.current().lastPlayedItemId)

        store.setServer("http://10.0.2.2:8787/")
        assertEquals("the same server keeps it", "sintel", store.current().lastPlayedItemId)
        store.forgetPairing()
        assertNull(store.current().lastPlayedItemId)

        store.setLastPlayedItem("tears")
        store.setServer("http://192.168.1.10:8787/")
        assertNull("another server's catalog", store.current().lastPlayedItemId)
    }

    @Test
    fun languageOverride() = runBlocking {
        assertNull(store.current().uiLanguageOverride)
        store.setUiLanguageOverride("tr")
        assertEquals("tr", store.current().uiLanguageOverride)
        store.setUiLanguageOverride(null)
        assertNull(store.current().uiLanguageOverride)
    }
}
