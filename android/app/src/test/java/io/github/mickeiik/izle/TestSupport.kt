package io.github.mickeiik.izle

import android.content.Intent
import android.content.pm.PackageInstaller
import io.github.mickeiik.izle.update.AppInstaller
import mockwebserver3.MockResponse
import java.security.MessageDigest

/** A JSON answer of an in-process test server. */
fun json(code: Int, body: String): MockResponse =
    MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** An install session's status as the system hands it to the activity. */
fun installStatus(status: Int, sessionId: Int = 7): Intent = Intent(AppInstaller.ACTION_INSTALL_STATUS)
    .putExtra(PackageInstaller.EXTRA_STATUS, status)
    .putExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId)
