package io.github.mickeiik.izle.ui.input

/**
 * Tells a short OK press (a click) from a long one (the hidden menu) on a remote.
 *
 * Every OK key event goes through here before the UI sees it. DOWN is held back; a key repeat at least
 * [thresholdMs] after the press opens the menu while the key is still held; the release then either delivers
 * the click (short press) or is swallowed (long press). A release without a matching press — e.g. the OK that
 * launched the app from the TV launcher — is swallowed too, so it cannot start playback by accident.
 */
class OkPressDetector(private val thresholdMs: Long = 600) {
    enum class Result {
        /** Nothing for the UI (yet). */
        Swallow,

        /** A short press: deliver a click. */
        Click,

        /** A long press: open the hidden menu. */
        LongPress,
    }

    private var pressedAt = -1L
    private var fired = false

    fun onDown(eventTimeMs: Long, downTimeMs: Long, repeatCount: Int): Result {
        if (repeatCount == 0) {
            pressedAt = downTimeMs
            fired = false
            return Result.Swallow
        }
        if (pressedAt < 0 || fired) return Result.Swallow
        if (eventTimeMs - pressedAt >= thresholdMs) {
            fired = true
            return Result.LongPress
        }
        return Result.Swallow
    }

    fun onUp(eventTimeMs: Long): Result {
        val result = when {
            pressedAt < 0 || fired -> Result.Swallow
            eventTimeMs - pressedAt >= thresholdMs -> Result.LongPress
            else -> Result.Click
        }
        reset()
        return result
    }

    /** Forget a press in progress (e.g. the window lost focus between DOWN and UP). */
    fun reset() {
        pressedAt = -1L
        fired = false
    }
}
