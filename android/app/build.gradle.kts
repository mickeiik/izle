plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    id("izle.robolectric-tests")
}

// Release signing is optional (IZLE_SIGNING_* or android/keystore.properties, see buildSrc's IzleSigning); without
// it, assembleRelease produces an unsigned APK. :companion is signed with the same key.
val releaseSigning = IzleSigning.read(providers, rootProject.layout.projectDirectory.file("keystore.properties"))

android {
    namespace = "io.github.mickeiik.izle"
    // compose-bom 2026.09.00 and core-ktx 1.19 require compiling against API 37; targetSdk stays 36.
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "io.github.mickeiik.izle"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = 36
        // The one version in gradle/libs.versions.toml; 1.2.3 → versionCode 10203 (buildSrc's IzleVersion).
        versionName = libs.versions.izle.get()
        versionCode = IzleVersion.code(libs.versions.izle.get())
    }

    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = rootProject.file(releaseSigning.storeFile)
                storePassword = releaseSigning.storePassword
                keyAlias = releaseSigning.keyAlias
                keyPassword = releaseSigning.keyPassword
            }
        }
    }

    buildTypes {
        debug {
            // The emulator reaches a server on the host here; release builds start with an empty address field.
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8787\"")
        }
        release {
            // R8 shrinks and optimizes (Compose runs much faster), without renaming: see proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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

    // The Compose UI tests run MainActivity under Robolectric, which needs the merged manifest and resources.
    testOptions.unitTests.isIncludeAndroidResources = true
}

dependencies {
    implementation(project(":core"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.tv.material)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.media3.ui.compose)
    implementation(libs.okhttp)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.qrcodegen)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.robolectric)
}
