package io.github.mickeiik.izle.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import io.github.mickeiik.izle.BuildConfig
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.MainActivity
import io.github.mickeiik.izle.apps.HomeScreenState
import kotlinx.coroutines.launch

/**
 * `MY_PACKAGE_REPLACED`: forgets the old update's state, and brings the new version to the front as
 * [UpdatePlan.reopenAfterUpdate] says (elsewhere the TV shows what was under izle until izle is opened again).
 */
class UpdateStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext as? IzleApp ?: return
        val pending = goAsync()
        app.graph.appScope.launch {
            try {
                // Read before onReplaced forgets it.
                val backgroundUpdateTo = app.graph.deviceStore.current().backgroundUpdateTo
                app.graph.updater.onReplaced()
                val homeScreen = app.graph.homeScreen.state() == HomeScreenState.Izle
                if (UpdatePlan.reopenAfterUpdate(Build.VERSION.SDK_INT, homeScreen, backgroundUpdateTo, BuildConfig.VERSION_CODE.toLong())) {
                    app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            } finally {
                pending.finish()
            }
        }
    }
}
