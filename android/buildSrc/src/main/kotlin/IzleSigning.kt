import org.gradle.api.file.RegularFile
import org.gradle.api.provider.ProviderFactory
import java.util.Properties

/**
 * The release key, the same for both apps so one key signs every APK of a release. CI passes the `IZLE_SIGNING_*`
 * environment variables; a local build reads `android/keystore.properties` (storeFile, storePassword, keyAlias,
 * keyPassword; never committed). Without either there is no release signing and assembleRelease produces an unsigned
 * APK. See docs/releasing.md.
 */
data class IzleSigning(val storeFile: String, val storePassword: String?, val keyAlias: String?, val keyPassword: String?) {
    companion object {
        /** Null without a store file. [keystoreProperties] is `android/keystore.properties`. */
        fun read(providers: ProviderFactory, keystoreProperties: RegularFile): IzleSigning? {
            val properties = Properties().apply {
                providers.fileContents(keystoreProperties).asText.orNull?.let { load(it.reader()) }
            }
            fun value(env: String, key: String): String? =
                providers.environmentVariable(env).orNull?.takeIf { it.isNotEmpty() } ?: properties.getProperty(key)
            return IzleSigning(
                storeFile = value("IZLE_SIGNING_STORE_FILE", "storeFile") ?: return null,
                storePassword = value("IZLE_SIGNING_STORE_PASSWORD", "storePassword"),
                keyAlias = value("IZLE_SIGNING_KEY_ALIAS", "keyAlias"),
                keyPassword = value("IZLE_SIGNING_KEY_PASSWORD", "keyPassword"),
            )
        }
    }
}
