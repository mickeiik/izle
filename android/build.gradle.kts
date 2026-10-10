plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin) and must NOT have org.jetbrains.kotlin.android applied.
    // Declaring it here with `apply false` only lifts the Kotlin Gradle Plugin on the build classpath
    // from the version AGP pins to libs.versions.kotlin; verify with `./gradlew buildEnvironment`.
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
