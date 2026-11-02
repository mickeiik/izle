package io.github.mickeiik.izle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import androidx.core.content.ContextCompat

/** Whether the TV's screen is on: off is standby, where izle in the background lets go of the server. */
class TvScreen(private val context: Context) {
    fun isOn(): Boolean = context.getSystemService(PowerManager::class.java)?.isInteractive != false

    /** Registered while the activity lives: [onChange] gets every switch on or off (standby). */
    fun watch(onChange: () -> Unit): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = onChange()
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        // The system sends these; nothing else may.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        return receiver
    }

    /** Undoes [watch]: the receiver is registered on [context], not on the activity. */
    fun unwatch(receiver: BroadcastReceiver) = context.unregisterReceiver(receiver)
}
