package io.github.mickeiik.izle.ui

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TimedValueTest {
    @Test
    fun showsForItsTimeThenGoes() = runTest {
        val shown = TimedValue<String>(this)
        assertNull(shown.value.value)
        shown.show("Hello", forMs = 3_000)
        assertEquals("Hello", shown.value.value)
        advanceTimeBy(2_999)
        runCurrent()
        assertEquals("Hello", shown.value.value)
        advanceTimeBy(1)
        runCurrent()
        assertNull(shown.value.value)
    }

    @Test
    fun aNewOneReplacesItAndStartsItsOwnTime() = runTest {
        val shown = TimedValue<String>(this)
        shown.show("Hello", forMs = 3_000)
        advanceTimeBy(2_000)
        shown.show("Dinner is ready", forMs = 4_000)
        assertEquals("Dinner is ready", shown.value.value)
        advanceTimeBy(3_999)
        runCurrent()
        assertEquals("the first one's time does not end the second", "Dinner is ready", shown.value.value)
        advanceTimeBy(1)
        runCurrent()
        assertNull(shown.value.value)
    }

    @Test
    fun clearingEndsItAtOnce() = runTest {
        val shown = TimedValue<String>(this)
        shown.show("Hello", forMs = 10_000)
        shown.clear()
        assertNull(shown.value.value)
        shown.show("Again", forMs = 5_000)
        advanceTimeBy(9_000)
        runCurrent()
        assertNull(shown.value.value)
    }
}
