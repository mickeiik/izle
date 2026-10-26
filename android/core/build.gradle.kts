plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
    id("izle.robolectric-tests")
}

// What the TV app shares with any other app of izle: the server API client and its models, the media engine and the
// domain helpers they need. Kotlin packages stay io.github.mickeiik.izle.*, so moving code here changes no import.
android {
    namespace = "io.github.mickeiik.izle.core"
    compileSdk = 37

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }

    // FakeMediaEngine and the test server helpers, for this module's tests and the apps' (testFixtures(project(":core"))).
    testFixtures {
        enable = true
    }
}

dependencies {
    // Their types are part of this module's API (ApiClient takes an OkHttpClient, MediaEngine exposes a media3 Player).
    api(libs.okhttp)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.android)
    api(libs.media3.exoplayer)
    implementation(libs.okhttp.sse)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.exoplayer.dash)
    implementation(libs.media3.datasource.okhttp)

    testFixturesApi(libs.okhttp.mockwebserver)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.robolectric)
    robolectricSdk(libs.robolectric.android.all)
}
