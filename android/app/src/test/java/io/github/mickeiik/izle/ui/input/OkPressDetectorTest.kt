package io.github.mickeiik.izle.ui.input

import io.github.mickeiik.izle.ui.input.OkPressDetector.Result
import org.junit.Assert.assertEquals
import org.junit.Test

class OkPressDetectorTest {
    private val detector = OkPressDetector(thresholdMs = 600)

    @Test
    fun shortPressClicksOnRelease() {
        assertEquals(Result.Swallow, detector.onDown(eventTimeMs = 1_000, downTimeMs = 1_000, repeatCount = 0))
        assertEquals(Result.Click, detector.onUp(eventTimeMs = 1_120))
    }

    @Test
    fun holdingOpensTheMenuOnceAndSwallowsTheRelease() {
        detector.onDown(0, 0, 0)
        // A remote repeats from ~400 ms on; the menu opens at the first repeat past 600 ms.
        assertEquals(Result.Swallow, detector.onDown(400, 0, 1))
        assertEquals(Result.Swallow, detector.onDown(450, 0, 2))
        assertEquals(Result.LongPress, detector.onDown(650, 0, 6))
        assertEquals(Result.Swallow, detector.onDown(700, 0, 7))
        assertEquals(Result.Swallow, detector.onUp(900))
    }

    @Test
    fun aLongHoldWithoutRepeatsCountsOnRelease() {
        detector.onDown(0, 0, 0)
        assertEquals(Result.LongPress, detector.onUp(800))
    }

    @Test
    fun aRepeatBeforeTheThresholdIsStillAClick() {
        // `adb shell input keyevent --longpress` holds for the system long-press timeout (400 ms) only.
        detector.onDown(0, 0, 0)
        assertEquals(Result.Swallow, detector.onDown(400, 0, 1))
        assertEquals(Result.Click, detector.onUp(400))
    }

    @Test
    fun aReleaseWithoutPressIsIgnored() {
        // e.g. the OK that launched the app from the TV launcher.
        assertEquals(Result.Swallow, detector.onUp(50))
        assertEquals(Result.Swallow, detector.onDown(100, 0, 3))
    }

    @Test
    fun resetForgetsAPressInProgress() {
        detector.onDown(0, 0, 0)
        detector.reset()
        assertEquals(Result.Swallow, detector.onUp(100))
        detector.onDown(200, 200, 0)
        assertEquals(Result.Click, detector.onUp(300))
    }
}
