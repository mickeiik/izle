import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing is optional: CI passes IZLE_SIGNING_* environment variables, a local build reads
// android/keystore.properties (storeFile, storePassword, keyAlias, keyPassword; never committed). Without either,
// assembleRelease produces an unsigned APK. See docs/releasing.md.
val keystoreProperties = Properties().apply {
    providers.fileContents(rootProject.layout.projectDirectory.file("keystore.properties")).asText.orNull
        ?.let { load(it.reader()) }
}
fun signingValue(env: String, key: String): String? =
    providers.environmentVariable(env).orNull?.takeIf { it.isNotEmpty() } ?: keystoreProperties.getProperty(key)
val releaseStoreFile = signingValue("IZLE_SIGNING_STORE_FILE", "storeFile")

android {
    namespace = "io.github.mickeiik.izle"
    // compose-bom 2026.09.00 and core-ktx 1.19 require compiling against API 37; targetSdk stays 36.
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.mickeiik.izle"
        minSdk = 24
        targetSdk = 36
        versionName = "0.2.0" // set with `node scripts/version.mjs set X.Y.Z`
        // 1.2.3 → 10203, so every release installs over the previous one (minor and patch stay below 100).
        versionCode = versionName!!.substringBefore('-').split('.').map(String::toInt)
            .let { (major, minor, patch) -> major * 10_000 + minor * 100 + patch }
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = signingValue("IZLE_SIGNING_STORE_PASSWORD", "storePassword")
                keyAlias = signingValue("IZLE_SIGNING_KEY_ALIAS", "keyAlias")
                keyPassword = signingValue("IZLE_SIGNING_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // The emulator reaches a server on the host here; release builds start with an empty address field.
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8787\"")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.tv.material)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.exoplayer.dash)
    implementation(libs.media3.datasource.okhttp)
    implementation(libs.media3.ui.compose)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
