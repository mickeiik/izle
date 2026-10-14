package io.github.mickeiik.izle.domain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CountdownTest {
    @Test
    fun ticksOnceASecondThenEndsASecondAfterTheLast() = runTest {
        val ticks = mutableListOf<Pair<Long, Int>>()
        var endedAt = -1L
        launch {
            countDown(3) { ticks += testScheduler.currentTime to it }
            endedAt = testScheduler.currentTime
        }
        advanceUntilIdle()
        assertEquals(listOf(0L to 3, 1_000L to 2, 2_000L to 1), ticks)
        assertEquals(3_000L, endedAt)
    }

    @Test
    fun aTickCanEndItEarly() = runTest {
        val ticks = mutableListOf<Int>()
        var announced = false
        launch {
            countDown(10) {
                if (it == 7) return@launch
                ticks += it
            }
            announced = true
        }
        advanceUntilIdle()
        assertEquals(listOf(10, 9, 8), ticks)
        assertEquals(false, announced)
        assertEquals("ended at the tick, without waiting", 3_000L, testScheduler.currentTime)
    }

    @Test
    fun cancellingStopsTheTicks() = runTest {
        val ticks = mutableListOf<Int>()
        var announced = false
        val job = launch {
            countDown(30) { ticks += it }
            announced = true
        }
        runCurrent()
        advanceTimeBy(1_500)
        job.cancel()
        advanceUntilIdle()
        assertEquals(listOf(30, 29), ticks)
        assertEquals(false, announced)
    }

    @Test
    fun nothingToCountEndsAtOnce() = runTest {
        var ticks = 0
        countDown(0) { ticks++ }
        assertEquals(0, ticks)
        assertEquals(0L, testScheduler.currentTime)
    }
}
