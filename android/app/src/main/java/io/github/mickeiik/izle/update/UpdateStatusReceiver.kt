package io.github.mickeiik.izle.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import io.github.mickeiik.izle.IzleApp
import io.github.mickeiik.izle.MainActivity
import kotlinx.coroutines.launch

/**
 * `MY_PACKAGE_REPLACED`: this app was just updated (by itself or through the system dialog). Forgets the old
 * update's state, and below Android 10 brings the new version to the front itself (allowed from a receiver there).
 * From Android 10 on no background activity start is allowed, not even the install session's status intent (the
 * system sends it with background starts denied), so the TV shows its launcher until izle is opened again.
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
