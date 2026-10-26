/** The apps' versionCode, derived from the one version in `gradle/libs.versions.toml` (`[versions] izle`). */
object IzleVersion {
    /**
     * `1.2.3` → `10203` (major·10000 + minor·100 + patch; a `-suffix` is ignored), so every release installs over the
     * previous one. `scripts/version.mjs` refuses a minor or patch of 100 or more.
     */
    fun code(name: String): Int {
        val parts = name.substringBefore('-').split('.').map(String::toInt)
        require(parts.size == 3 && parts[1] < 100 && parts[2] < 100) { "not a version like 1.2.3 (minor and patch < 100): $name" }
        val (major, minor, patch) = parts
        return major * 10_000 + minor * 100 + patch
    }
}
