package io.github.mickeiik.izle.ui.common

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import io.github.mickeiik.izle.R
import io.github.mickeiik.izle.domain.EpisodeName
import io.github.mickeiik.izle.domain.TileBadge
import io.github.mickeiik.izle.ui.theme.IzleBorders
import io.github.mickeiik.izle.ui.theme.IzleColors
import io.github.mickeiik.izle.ui.theme.IzleShapes
import io.github.mickeiik.izle.ui.theme.IzleSpacing
import java.util.Locale

/**
 * Makes `stringResource` follow the server-set UI language instead of the system locale. The wrapper keeps the
 * activity as base context so anything looking for it still finds it.
 */
@Composable
fun LocalizedContent(language: String, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val localized = remember(base, language) {
        val config = Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        val resources = base.createConfigurationContext(config).resources
        object : ContextWrapper(base) {
            override fun getResources(): Resources = resources
        }
    }
    CompositionLocalProvider(
        LocalContext provides localized,
        LocalResources provides localized.resources,
        LocalConfiguration provides localized.resources.configuration,
        content = content,
    )
}

fun Context.currentLocale(): Locale = resources.configuration.locales[0]

@Composable
fun episodeNameText(name: EpisodeName): String? = when (name) {
    EpisodeName.None -> null
    is EpisodeName.Label -> name.text
    is EpisodeName.Numbered ->
        if (name.season != null) stringResource(R.string.episode_season_number, name.season, name.number)
        else stringResource(R.string.episode_number, name.number)
}

/**
 * What a home tile's chip says: New / Continue / Watch again, the episode OK plays ("Continue · Episode 2"), or Live
 * for a channel.
 */
@Composable
fun tileBadgeText(badge: TileBadge): String = when (badge) {
    TileBadge.Live -> stringResource(R.string.badge_live)
    TileBadge.New -> stringResource(R.string.badge_new)
    TileBadge.Continue -> stringResource(R.string.badge_continue)
    TileBadge.WatchAgain -> stringResource(R.string.badge_watch_again)
    is TileBadge.Episode -> {
        val name = episodeNameText(badge.name).orEmpty()
        if (badge.resume) stringResource(R.string.badge_continue_episode, name) else name
    }
}

/** 1:05:09 or 5:09. */
fun formatTime(ms: Long): String {
    val total = (ms.coerceAtLeast(0) / 1000)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(Locale.ROOT, h, m, s) else "%d:%02d".format(Locale.ROOT, m, s)
}

/** A language tag as a name in the UI language ("it" → "Italian" / "İtalyanca"). */
fun languageName(tag: String?, uiLocale: Locale): String? {
    if (tag.isNullOrBlank() || tag == "und") return null
    val name = Locale.forLanguageTag(tag).getDisplayName(uiLocale)
    if (name.isBlank() || name == tag) return tag
    return name.replaceFirstChar { if (it.isLowerCase()) it.titlecase(uiLocale) else it.toString() }
}

@Composable
fun languageLabel(tag: String): String = stringResource(if (tag == "tr") R.string.language_tr else R.string.language_en)

@Composable
fun Spinner(modifier: Modifier = Modifier, size: Dp = 72.dp) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val angle by transition.animateFloat(0f, 360f, infiniteRepeatable(tween(1_000, easing = LinearEasing), RepeatMode.Restart), label = "angle")
    Canvas(modifier.size(size)) {
        val stroke = this.size.minDimension / 10
        rotate(angle) {
            drawArc(IzleColors.OnSurface, startAngle = 0f, sweepAngle = 270f, useCenter = false, topLeft = Offset(stroke / 2, stroke / 2),
                size = Size(this.size.width - stroke, this.size.height - stroke), style = Stroke(stroke, cap = StrokeCap.Round))
        }
    }
}

@Composable
fun PlayIcon(modifier: Modifier = Modifier, color: Color = IzleColors.OnSurface) {
    Canvas(modifier) {
        val path = Path().apply {
            moveTo(size.width * 0.2f, size.height * 0.1f)
            lineTo(size.width * 0.9f, size.height * 0.5f)
            lineTo(size.width * 0.2f, size.height * 0.9f)
            close()
        }
        drawPath(path, color)
    }
}

@Composable
fun PauseIcon(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width * 0.28f
        drawRect(IzleColors.OnSurface, topLeft = Offset(size.width * 0.14f, size.height * 0.1f), size = Size(w, size.height * 0.8f))
        drawRect(IzleColors.OnSurface, topLeft = Offset(size.width * 0.58f, size.height * 0.1f), size = Size(w, size.height * 0.8f))
    }
}

@Composable
fun CheckIcon(modifier: Modifier, color: Color) {
    Canvas(modifier) {
        val path = Path().apply {
            moveTo(size.width * 0.12f, size.height * 0.52f)
            lineTo(size.width * 0.4f, size.height * 0.8f)
            lineTo(size.width * 0.9f, size.height * 0.22f)
        }
        drawPath(path, color, style = Stroke(size.minDimension * 0.14f, cap = StrokeCap.Round))
    }
}

/** A thin progress bar (tile progress, player position). */
@Composable
fun ProgressBar(fraction: Float, height: Dp = 6.dp) {
    Box(Modifier.fillMaxWidth().height(height).background(IzleColors.ProgressTrack, IzleShapes.Pill)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(height).background(IzleColors.Accent, IzleShapes.Pill))
    }
}

/** A whole screen in [background], its content inside the safe margins. */
fun Modifier.fullScreen(background: Color = IzleColors.Background): Modifier =
    fillMaxSize().background(background).padding(IzleSpacing.Safe)

/**
 * Asks for the focus once a frame, from the next frame on and for up to 10 frames, until the request goes through and
 * [took] says the focus really arrived: the screen may still be laying out. [requester] is looked up again each frame,
 * since a lazy list composes its rows late (null: not there yet).
 */
suspend fun requestFocusWithin(requester: () -> FocusRequester?, took: () -> Boolean = { true }) {
    repeat(10) {
        withFrameNanos { }
        val r = requester() ?: return@repeat
        if (runCatching { r.requestFocus() }.isSuccess && took()) return
    }
}

/** A line saying what went wrong (server address, pairing, the episode list): one size and colour everywhere. */
@Composable
fun ErrorText(text: String, textAlign: TextAlign? = null) {
    Text(text, style = MaterialTheme.typography.headlineSmall, color = IzleColors.Error, textAlign = textAlign)
}

/**
 * The app's one button: dark with a grey outline, and white with a white border, 10 % larger, while focused, so the
 * focused one is unmistakable from across the room.
 */
@Composable
fun TvButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        scale = ButtonDefaults.scale(focusedScale = 1.1f),
        shape = ButtonDefaults.shape(IzleShapes.Pill),
        colors = ButtonDefaults.colors(
            containerColor = IzleColors.SurfaceHigh,
            contentColor = IzleColors.OnSurface,
            focusedContainerColor = IzleColors.Focus,
            focusedContentColor = IzleColors.OnFocus,
            pressedContainerColor = IzleColors.Focus,
            pressedContentColor = IzleColors.OnFocus,
            disabledContainerColor = IzleColors.Surface,
            disabledContentColor = IzleColors.Dim,
        ),
        border = ButtonDefaults.border(
            border = IzleBorders.outline(IzleShapes.Pill),
            focusedBorder = IzleBorders.focus(IzleShapes.Pill),
            pressedBorder = IzleBorders.focus(IzleShapes.Pill),
            disabledBorder = IzleBorders.outline(IzleShapes.Pill),
            focusedDisabledBorder = IzleBorders.focus(IzleShapes.Pill),
        ),
        contentPadding = PaddingValues(horizontal = IzleSpacing.XXLarge, vertical = IzleSpacing.Small),
    ) {
        Text(text, style = MaterialTheme.typography.titleLarge, maxLines = 1)
    }
}

/**
 * The owner's message: 30 sp bold, stepping down to 24 sp only when a long one would not fit otherwise, at most three
 * lines, dark on the warm accent so it stands out on any picture. Not focusable, no buttons: it goes away by itself.
 */
@Composable
fun MessageBanner(
    text: String,
    modifier: Modifier = Modifier,
    textAlign: TextAlign = TextAlign.Start,
) {
    BasicText(
        text,
        style = MaterialTheme.typography.headlineSmall.copy(color = IzleColors.OnAccent, lineHeight = 1.25.em, textAlign = textAlign),
        maxLines = 3,
        overflow = TextOverflow.Ellipsis,
        autoSize = TextAutoSize.StepBased(minFontSize = 24.sp, maxFontSize = 30.sp, stepSize = 2.sp),
        modifier = modifier
            .border(IzleBorders.OutlineWidth, IzleColors.BannerEdge, IzleShapes.Large)
            .background(IzleColors.Accent, IzleShapes.Large)
            .padding(horizontal = IzleSpacing.XLarge, vertical = IzleSpacing.Medium),
    )
}

/** The banner across the top of the screen, inside the safe margins (864 dp wide): over Home, the video, menu and overlays. */
@Composable
fun MessageBannerOverlay(text: String, modifier: Modifier) {
    Box(modifier.fillMaxWidth().padding(IzleSpacing.Safe), contentAlignment = Alignment.TopCenter) {
        MessageBanner(text, Modifier.widthIn(max = 864.dp), textAlign = TextAlign.Center)
    }
}
