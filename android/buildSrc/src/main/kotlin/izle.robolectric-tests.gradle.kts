// Robolectric runs the unit tests that need Android on this Android framework jar (one SDK: see the tests' @Config).
// Gradle resolves it like any other dependency and the tests read it from there (offline mode), so a test run never
// downloads anything. The jar's version is the catalog's robolectric-android-all.
val robolectricSdk: Configuration = configurations.create("robolectricSdk") {
    isCanBeConsumed = false
    isTransitive = false
}
dependencies.addProvider(
    robolectricSdk.name,
    extensions.getByType<VersionCatalogsExtension>().named("libs").findLibrary("robolectric-android-all").get(),
)

class RobolectricOffline(
    @get:InputFiles @get:PathSensitive(PathSensitivity.NAME_ONLY) val sdkJar: FileCollection,
) : CommandLineArgumentProvider {
    override fun asArguments() = listOf(
        "-Drobolectric.offline=true",
        "-Drobolectric.dependency.dir=${sdkJar.singleFile.parentFile.absolutePath}",
    )
}

tasks.withType<Test>().configureEach {
    jvmArgumentProviders.add(RobolectricOffline(robolectricSdk))
    // On Java 17+ Robolectric needs these JDK internals opened (https://robolectric.org/getting-started/).
    val opened = listOf("java.lang", "java.util", "java.io", "java.net", "java.security", "java.text", "jdk.internal.access")
    jvmArgs(
        opened.map { "--add-opens=java.base/$it=ALL-UNNAMED" } +
            listOf("--add-opens=java.desktop/java.awt.font=ALL-UNNAMED", "--add-opens=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED"),
    )
}
