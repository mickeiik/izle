# R8 for release builds. kotlinx.serialization, OkHttp, Media3 and Compose ship their own consumer rules.

# No renaming: exception class names stay meaningful in what the app shows and reports, and stack traces stay
# readable without a mapping file. Shrinking and optimization, where the speed comes from, still apply.
-dontobfuscate
