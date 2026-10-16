package io.github.mickeiik.izle.update

import io.github.mickeiik.izle.data.api.ApiClient
import io.github.mickeiik.izle.data.api.ApiException
import io.github.mickeiik.izle.data.api.ApiJson
import io.github.mickeiik.izle.data.api.CommandResult
import io.github.mickeiik.izle.data.api.ErrorBody
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import okhttp3.OkHttpClient
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Why an update did not happen, as the command result's `reason`. [ignored]: nothing was wrong (`not_newer`,
 * `up_to_date`, `busy`), so the result is `ignored`, not `failed`, and no failure is remembered.
 */
class UpdateException(val reason: String, val ignored: Boolean = false) : Exception(reason)

/**
 * Streams `GET /tv/app/apk` into [dir]/update.apk, hashing it on the way. Nothing is kept unless the whole file
 * arrived and its SHA-256 is the one `GET /tv/app` announced.
 */
class ApkDownloader(private val http: OkHttpClient, private val dir: File, private val maxBytes: Long = MAX_BYTES) {
    val file: File get() = File(dir, FILE_NAME)

    /**
     * The verified file. Throws [UpdateException] `too_large` (over [MAX_BYTES], checked on the announced size and
     * `Content-Length` before reading, then while reading), `download` (network failure, short body) or `verify` (another hash), and
     * [ApiException] for an error answer (`404 no_apk`).
     */
    // Interruptible: cancelling the coroutine interrupts the blocking read, which OkHttp turns into an IOException.
    suspend fun download(api: ApiClient, update: AvailableUpdate): File = runInterruptible(Dispatchers.IO) {
        if (update.size > maxBytes) throw UpdateException(CommandResult.TOO_LARGE)
        val target = file
        target.delete()
        try {
            http.newCall(api.apkRequest()).execute().use { response ->
                if (response.code !in 200..299) {
                    val body = runCatching { response.body.string() }.getOrDefault("")
                    val code = runCatching { ApiJson.decodeFromString(ErrorBody.serializer(), body).error }.getOrNull() ?: "http_${response.code}"
                    throw ApiException(response.code, code)
                }
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
        } catch (e: IOException) {
            target.delete()
            throw UpdateException(CommandResult.DOWNLOAD)
        } catch (e: Throwable) {
            target.delete()
            throw e
        }
    }

    /** Throws away a downloaded file (installed, refused, or never to be installed). */
    fun clear() {
        file.delete()
    }

    companion object {
        const val FILE_NAME = "update.apk"

        /** The TV app is a few MB; anything this big is not it (and would fill a small TV's storage). */
        const val MAX_BYTES = 64L * 1024 * 1024
    }
}
