package io.github.mickeiik.izle.update

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.apiError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import okhttp3.OkHttpClient
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** [reason]: the command result's. [ignored]: nothing was wrong (`not_newer`), no failure is remembered. */
class UpdateException(val reason: String, val ignored: Boolean = false) : Exception(reason)

/** Streams `GET /tv/app/apk` into [dir]; nothing is kept unless the whole file arrived with the announced SHA-256. */
class ApkDownloader(private val http: OkHttpClient, private val dir: File, private val maxBytes: Long = MAX_BYTES) {
    val file: File get() = File(dir, FILE_NAME)

    /** Throws [UpdateException] `too_large`, `download` or `verify`, and [ApiException] for an error answer (`404 no_apk`). */
    // Interruptible: cancelling the coroutine interrupts the blocking read, which OkHttp turns into an IOException.
    suspend fun download(api: ApiClient, update: AvailableUpdate): File = runInterruptible(Dispatchers.IO) {
        if (update.size > maxBytes) throw UpdateException(CommandResult.TOO_LARGE)
        val target = file
        target.delete()
        try {
            http.newCall(api.apkRequest()).execute().use { response ->
                if (response.code !in 200..299) throw apiError(response.code, runCatching { response.body.string() }.getOrDefault(""))
                val length = response.body.contentLength()
                if (length > maxBytes) throw UpdateException(CommandResult.TOO_LARGE)
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                response.body.byteStream().use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > maxBytes) throw UpdateException(CommandResult.TOO_LARGE)
                            digest.update(buffer, 0, n)
                            output.write(buffer, 0, n)
                        }
                        output.fd.sync()
                    }
                }
                if (length >= 0 && total != length) throw UpdateException(CommandResult.DOWNLOAD)
                val hex = digest.digest().joinToString("") { "%02x".format(it) }
                if (!hex.equals(update.sha256, ignoreCase = true)) throw UpdateException(CommandResult.VERIFY)
            }
            target
        } catch (e: Throwable) {
            target.delete()
            throw if (e is IOException) UpdateException(CommandResult.DOWNLOAD) else e
        }
    }

    fun clear() {
        file.delete()
    }

    companion object {
        const val FILE_NAME = "update.apk"

        /** The TV app is a few MB; anything this big is not it (and would fill a small TV). */
        const val MAX_BYTES = 64L * 1024 * 1024
    }
}
