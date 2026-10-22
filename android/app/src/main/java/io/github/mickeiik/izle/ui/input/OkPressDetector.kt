package io.github.mickeiik.izle.ui.input

/**
 * Tells a short OK press (a click) from a long one (the hidden menu). DOWN is held back; a repeat [thresholdMs] after
 * the press opens the menu while the key is held; the release then delivers the click or is swallowed. A release
 * without a press (the OK that launched the app from the TV launcher) is swallowed too: it cannot start playback.
 */
class OkPressDetector(private val thresholdMs: Long = 600) {
    enum class Result { Swallow, Click, LongPress }

    private var pressedAt = -1L
    private var fired = false

    fun onDown(eventTimeMs: Long, downTimeMs: Long, repeatCount: Int): Result {
        if (repeatCount == 0) {
            pressedAt = downTimeMs
            fired = false
        } else if (pressedAt >= 0 && !fired && eventTimeMs - pressedAt >= thresholdMs) {
            fired = true
            return Result.LongPress
        }
        return Result.Swallow
    }

    fun onUp(eventTimeMs: Long): Result = when {
        pressedAt < 0 || fired -> Result.Swallow
        eventTimeMs - pressedAt >= thresholdMs -> Result.LongPress
        else -> Result.Click
    }.also { reset() }

    /** Forgets a press in progress (the window lost focus between DOWN and UP). */
    fun reset() {
        pressedAt = -1L
        fired = false
    }
}
