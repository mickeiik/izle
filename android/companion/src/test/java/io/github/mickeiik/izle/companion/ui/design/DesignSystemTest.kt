package io.github.mickeiik.izle.companion.ui.design

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The look lives in the design system (docs/ux/companion-design.md): outside `ui/design`, no source file uses colour,
 * shape, type or dp/sp literals, styles a Material button or card itself, or reads a Material colour or type style by
 * name. Screens use `IzleTheme`'s tokens and the design system's components.
 */
class DesignSystemTest {
    @Test
    fun onlyTheDesignSystemStylesTheApp() {
        val found = sources().mapNotNull { (path, text) ->
            violations(text).takeIf { it.isNotEmpty() }?.let { "$path: ${it.joinToString()}" }
        }
        assertEquals("styled outside ui/design (use IzleTheme and the design components)", emptyList<String>(), found)
    }

    /** The companion's main Kotlin sources outside `ui/design`, by path relative to the package root. */
    private fun sources(): Map<String, String> {
        val root = listOf(File("src/main/java"), File("companion/src/main/java"))
            .map { File(it, PACKAGE_DIR) }
            .first { it.isDirectory }
        return root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .map { it.relativeTo(root).invariantSeparatorsPath to it.readText() }
            .filter { (path, _) -> !path.startsWith("ui/design/") }
            .toMap()
    }

    private fun violations(source: String): List<String> {
        val code = source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "")
        return RULES.flatMap { (what, rule) -> rule.findAll(code).map { "$what `${it.value}`" } }.distinct()
    }

    private companion object {
        const val PACKAGE_DIR = "io/github/mickeiik/izle/companion"

        val RULES = listOf(
            "a colour literal" to Regex("""\bColor\(|\bColor\.[A-Z]\w*"""),
            "a shape literal" to Regex("""\b(RoundedCornerShape|CutCornerShape)\("""),
            "a font size" to Regex("""\bfontSize\s*="""),
            "a font weight" to Regex("""\bFontWeight\.\w+"""),
            "a dp or sp literal" to Regex("""\b\d+(\.\d+)?f?\.(dp|sp)\b"""),
            "a styled Material button or card" to Regex("""\b(ButtonDefaults|CardDefaults|IconButtonDefaults|NavigationBarItemDefaults)\.\w+"""),
            "a Material colour by name" to Regex("""\bMaterialTheme\.colorScheme\.\w+"""),
            "a Material type style" to Regex("""\bMaterialTheme\.typography\b"""),
            "a Material shape" to Regex("""\bMaterialTheme\.shapes\b"""),
        )

        val BLOCK_COMMENT = Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL)
        val LINE_COMMENT = Regex("""(?m)(^|\s)//.*$""")
    }
}
