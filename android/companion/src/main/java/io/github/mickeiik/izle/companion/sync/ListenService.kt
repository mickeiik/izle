package io.github.mickeiik.izle.companion.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.mickeiik.izle.companion.CompanionApp
import io.github.mickeiik.izle.companion.MainActivity
import io.github.mickeiik.izle.companion.R
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps Listen along playing with the screen off: a foreground service (type `mediaPlayback`) with an ongoing
 * notification that shows what plays and how well it is in sync, and a Stop action. It follows the graph's current
 * [ListenSession] and stops itself when that goes idle. Plain on purpose: no media session.
 */
class ListenService : Service() {
    private val scope = MainScope()
    private var follow: Job? = null
    private var foreground = false
    private var lastNotifiedAt = 0L
    private var lastShown: Shown? = null

    /** What the notification says; a change of title or phase updates it at once, the sync label once a second. */
    private data class Shown(val title: String, val text: String, val phase: ListenPhase)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val session = (application as CompanionApp).graph.currentSession
        if (intent?.action == ACTION_STOP) {
            session?.stop()
            if (!foreground) stopSelf()
            return START_NOT_STICKY
        }
        // Started with startForegroundService: it must be in the foreground before anything else, even to stop.
        createChannel()
        val state = session?.state?.value ?: ListenState()
        val shown = shown(state)
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(shown), mediaPlaybackType())
        foreground = true
        lastShown = shown
        lastNotifiedAt = SystemClock.elapsedRealtime()
        if (session == null || state.phase == ListenPhase.Idle) {
            finish()
            return START_NOT_STICKY
        }
        if (follow == null) {
            follow = scope.launch {
                session.state.collect { s ->
                    if (s.phase == ListenPhase.Idle) finish() else update(s)
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun update(state: ListenState) {
        val shown = shown(state)
        val previous = lastShown
        if (shown == previous) return
        val now = SystemClock.elapsedRealtime()
        val urgent = previous == null || previous.title != shown.title || previous.phase != shown.phase
        if (!urgent && now - lastNotifiedAt < MIN_UPDATE_MS) return
        lastNotifiedAt = now
        lastShown = shown
        // Without the permission (Android 13+, refused) the notification is not shown; the service runs anyway.
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(shown))
        }
    }

    private fun finish() {
        follow?.cancel()
        follow = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun shown(state: ListenState): Shown {
        val title = state.target?.itemTitle ?: getString(R.string.app_name)
        val label = state.syncLabel ?: getString(R.string.notification_starting)
        val text = listOfNotNull(state.target?.episodeTitle, label).joinToString(" · ")
        return Shown(title, text, state.phase)
    }

    private fun notification(shown: Shown): Notification {
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ListenService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(shown.title)
            .setContentText(shown.text)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notification_stop), stop)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun mediaPlaybackType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0

    companion object {
        const val ACTION_STOP = "io.github.mickeiik.izle.companion.action.STOP_LISTENING"
        const val CHANNEL_ID = "listen_along"
        const val NOTIFICATION_ID = 1
        private const val MIN_UPDATE_MS = 1000L

        /** When listening starts (from the screen, so the app is in the foreground and may start it). */
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ListenService::class.java))
        }

        /** Stops listening; the service then stops itself. */
        fun stop(context: Context) {
            context.startService(Intent(context, ListenService::class.java).setAction(ACTION_STOP))
        }
    }
}
