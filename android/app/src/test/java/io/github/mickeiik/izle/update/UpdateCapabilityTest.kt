package io.github.mickeiik.izle.update

import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateCapabilityTest {
    @Test
    fun silentNeedsAndroid12TheGrantAndNoRefusal() {
        val table = listOf(
            Triple(25, true, false) to UpdateCapability.Guided, // the Freebox Player Mini v2 (Android 7.1.1)
            Triple(30, true, false) to UpdateCapability.Guided,
            Triple(31, false, false) to UpdateCapability.Guided,
            Triple(31, true, false) to UpdateCapability.Silent,
            Triple(36, true, false) to UpdateCapability.Silent,
            Triple(36, true, true) to UpdateCapability.Guided,
            Triple(36, false, true) to UpdateCapability.Guided,
        )
        for ((input, expected) in table) {
            val (sdk, grant, refused) = input
            assertEquals("$input", expected, UpdateCapabilities.of(sdk, grant, refused))
        }
    }

    @Test
    fun theUserAgentSaysVersionAndroidAndCapability() {
        assertEquals("izle-tv/0.3.0 (Android 25; 300; guided)", UpdateCapabilities.userAgent("0.3.0", 300, 25, UpdateCapability.Guided))
        assertEquals("izle-tv/0.2.0 (Android 34; 200; silent)", UpdateCapabilities.userAgent("0.2.0", 200, 34, UpdateCapability.Silent))
    }
}
