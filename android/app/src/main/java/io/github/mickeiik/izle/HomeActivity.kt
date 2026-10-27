package io.github.mickeiik.izle

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * izle as the TV's home screen (off until chosen, see [io.github.mickeiik.izle.apps.HomeScreenSwitch]): HOME, the TV
 * switched on, or the system restarting its home screen (after a self-update) start this, in the system's home task;
 * it hands over to MainActivity in MainActivity's own task (this one has no task affinity, so MainActivity never
 * lands in the home task) and is gone. MainActivity itself cannot be the home activity: Android would start a second
 * one in the home task beside the one in front, and two would share one app.
 */
class HomeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handOver()
    }

    /** Should one still be there when HOME comes. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handOver()
    }

    private fun handOver() {
        startActivity(Intent(this, MainActivity::class.java).setAction(ACTION_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        // A NoDisplay activity must be gone before it would show.
        finish()
    }

    companion object {
        /** MainActivity's intent from here: HOME, or the system opening its home screen. */
        const val ACTION_HOME = "io.github.mickeiik.izle.action.HOME"
    }
}
