package io.github.mickeiik.izle

import android.content.Intent
import android.content.pm.PackageInstaller
import io.github.mickeiik.izle.update.AppInstaller

/** An install session's status as the system hands it to the activity. */
fun installStatus(status: Int, sessionId: Int = 7): Intent = Intent(AppInstaller.ACTION_INSTALL_STATUS)
    .putExtra(PackageInstaller.EXTRA_STATUS, status)
    .putExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId)
