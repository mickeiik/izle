package io.github.mickeiik.izle.companion.ui.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The icons `material-icons-core` lacks (Material's own paths), tinted like any icon. */
object IzleIcons {
    val SkipPrevious: ImageVector = icon("SkipPrevious", "M6,6h2v12H6zM9.5,12l8.5,6V6z")
    val SkipNext: ImageVector = icon("SkipNext", "M6,18l8.5,-6L6,6v12zM16,6v12h2V6h-2z")
    val Pause: ImageVector = icon("Pause", "M6,19h4V5H6v14zM14,5v14h4V5h-4z")
    val FastRewind: ImageVector = icon("FastRewind", "M11,18V6l-8.5,6 8.5,6zM11.5,12l8.5,6V6l-8.5,6z")
    val FastForward: ImageVector = icon("FastForward", "M4,18l8.5,-6L4,6v12zM13,6v12l8.5,-6L13,6z")
    val Stop: ImageVector = icon("Stop", "M6,6h12v12H6z")
    val Headphones: ImageVector = icon(
        "Headphones",
        "M12,3c-4.97,0 -9,4.03 -9,9v7c0,1.1 0.9,2 2,2h4v-8H5v-1c0,-3.87 3.13,-7 7,-7s7,3.13 7,7v1h-4v8h4c1.1,0 2,-0.9 2,-2v-7c0,-4.97 -4.03,-9 -9,-9z",
    )
    val Message: ImageVector = icon(
        "ChatBubbleOutline",
        "M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM20,16H5.17L4,17.17V4h16v12z",
    )
    val Tv: ImageVector = icon("Tv", "M21,3H3c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h5v2h8v-2h5c1.1,0 1.99,-0.9 1.99,-2L23,5c0,-1.1 -0.9,-2 -2,-2zM21,17H3V5h18v12z")
    val Grid: ImageVector = icon("GridView", "M3,3v8h8V3H3zM9,9H5V5h4V9zM3,13v8h8v-8H3zM9,19H5v-4h4V19zM13,3v8h8V3H13zM19,9h-4V5h4V9zM13,13v8h8v-8H13zM19,19h-4v-4h4V19z")
    val DragHandle: ImageVector = icon("DragIndicator", "M11,18c0,1.1 -0.9,2 -2,2s-2,-0.9 -2,-2 0.9,-2 2,-2 2,0.9 2,2zM9,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM9,4c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM15,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM15,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM15,16c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z")
    val ExpandMore: ImageVector = icon("ExpandMore", "M16.59,8.59L12,13.17 7.41,8.59 6,10l6,6 6,-6z")
    val Library: ImageVector = icon("LibraryBooks", "M4,6H2v14c0,1.1 0.9,2 2,2h14v-2H4V6zM20,2H8c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM20,16H8V4h12v12zM10,9h8v2h-8zM10,12h4v2h-4zM10,6h8v2h-8z")
    val Sparkle: ImageVector = icon("AutoAwesome", "M19,9l1.25,-2.75L23,5l-2.75,-1.25L19,1l-1.25,2.75L15,5l2.75,1.25L19,9zM11.5,9.5L9,4L6.5,9.5L1,12l5.5,2.5L9,20l2.5,-5.5L17,12L11.5,9.5zM19,15l-1.25,2.75L15,19l2.75,1.25L19,23l1.25,-2.75L23,19l-2.75,-1.25L19,15z")
    val ExpandLess: ImageVector = icon("ExpandLess", "M12,8l-6,6 1.41,1.41L12,10.83l4.59,4.58L18,14z")
    /** An app card without a picture. */
    val Apps: ImageVector = icon("Apps", "M4,8h4V4H4v4zM10,20h4v-4h-4v4zM4,20h4v-4H4v4zM4,14h4v-4H4v4zM10,14h4v-4h-4v4zM16,4v4h4V4h-4zM10,8h4V4h-4v4zM16,14h4v-4h-4v4zM16,20h4v-4h-4v4z")
    /** The TV tab's: sliders. */
    val Tune: ImageVector = icon("Tune", "M3,17v2h6v-2H3zM3,5v2h10V5H3zM13,21v-2h8v-2h-8v-2h-2v6h2zM7,9v2H3v2h4v2h2V9H7zM21,13v-2H11v2h10zM15,9h2V7h4V5h-4V3h-2v6z")

    private fun icon(name: String, path: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
            .addPath(addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
}
