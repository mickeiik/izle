package io.github.mickeiik.izle.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.MainActivity
import io.github.mickeiik.izle.apps.HomeScreenState
import kotlinx.coroutines.launch

/**
 * `MY_PACKAGE_REPLACED`: forgets the old update's state, and brings the new version to the front below Android 10
 * (allowed from a receiver there; later the TV shows what was under izle until izle is opened again), and on any
 * version while izle is the TV's home screen (the home app may start activities from the background).
 */
class UpdateStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext as? IzleApp ?: return
        val pending = goAsync()
        app.graph.appScope.launch {
            try {
                app.graph.updater.onReplaced()
            } finally {
                pending.finish()
            }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || app.graph.homeScreen.state() == HomeScreenState.Izle) {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
