# R8 for release builds. kotlinx.serialization, Coil, OkHttp, Media3 and Compose ship their own consumer rules.

# No renaming: problem reports send exception class names to the server (Problems.classChain), and stack traces stay
# readable without a mapping file. Shrinking and optimization, where the speed comes from, still apply.
-dontobfuscate
