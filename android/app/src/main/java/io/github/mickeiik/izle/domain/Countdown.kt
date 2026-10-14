package io.github.mickeiik.izle.domain

import kotlinx.coroutines.delay

/**
 * An on-screen countdown ("Up next", the error screen's way back Home, autoplay on start): [tick] shows the seconds
 * left, from [seconds] down to 1, the first at once and then one a second. It returns a second after the last tick,
 * when the caller does what the countdown announced. Inlined, so [tick] can end the countdown early with a `return`
 * from the enclosing coroutine.
 */
suspend inline fun countDown(seconds: Int, tick: (secondsLeft: Int) -> Unit) {
    for (left in seconds downTo 1) {
        tick(left)
        delay(1_000)
    }
}
