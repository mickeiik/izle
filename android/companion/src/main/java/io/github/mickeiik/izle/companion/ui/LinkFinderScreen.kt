package io.github.mickeiik.izle.companion.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.finder.FoundLink
import io.github.mickeiik.izle.companion.finder.LinkFinder
import io.github.mickeiik.izle.companion.finder.addressUrl
import io.github.mickeiik.izle.companion.finder.isHttpUrl

/**
 * The link finder: a browser for the page that plays the episode. Every request the page makes is offered to
 * [finder], which confirms the playlists among them; once one is found, **Listen to this** hands it over. A link found
 * elsewhere can be pasted instead. A found link's URL is never shown: the address row shows the page's URL only.
 * What is typed or found stays in memory (no saved state).
 */
@Composable
fun LinkFinderScreen(
    finder: LinkFinder,
    initialUrl: String?,
    onListenToThis: (FoundLink) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by finder.state.collectAsStateWithLifecycle()
    val currentFinder by rememberUpdatedState(finder)
    val focus = LocalFocusManager.current
    var address by remember { mutableStateOf(addressUrl(initialUrl.orEmpty()) ?: initialUrl.orEmpty()) }
    var pasted by remember { mutableStateOf("") }
    var pasteOpen by remember { mutableStateOf(false) }
    val browser = remember { BrowserHolder() }
    val background = MaterialTheme.colorScheme.surface.toArgb()

    BackHandler {
        val web = browser.view
        if (web != null && canGoBackToAPage(web)) web.goBack() else onClose()
    }
    val go = {
        addressUrl(address)?.let { url ->
            address = url
            browser.view?.loadUrl(url)
        }
        focus.clearFocus()
    }
    val togglePaste = {
        // The error belongs to the field: it goes when the field is hidden, and a reopened field starts clean.
        pasteOpen = !pasteOpen
        pasted = ""
        finder.dismissPasteError()
        if (!pasteOpen) focus.clearFocus()
    }
    val found = state.found
    // Once a stream is found, the bar offers it alone: the paste field closes.
    LaunchedEffect(found != null) {
        if (found != null) {
            pasteOpen = false
            pasted = ""
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        // The address row is the finder's whole chrome (no app bar above it). It is drawn before the WebView, in its
        // own surface, and the WebView is clipped to its own bounds so it never paints over the row.
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.finder_close))
                }
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    label = { Text(stringResource(R.string.finder_address)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { go() }),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = go) { Text(stringResource(R.string.finder_go)) }
            }
        }
        AndroidView(
            factory = { context ->
                newBrowser(
                    context,
                    background = background,
                    onRequest = { url, headers -> currentFinder.offer(url, headers, CookieManager.getInstance().getCookie(url)) },
                    onPage = { url -> if (isHttpUrl(url)) address = url },
                ).also { web ->
                    browser.view = web
                    // A blank page when there is nothing to open yet: the view has content and a layout from the start.
                    web.loadUrl(addressUrl(initialUrl.orEmpty()) ?: BLANK)
                }
            },
            onRelease = { web ->
                if (browser.view === web) browser.view = null
                web.stopLoading()
                web.destroy()
            },
            modifier = Modifier.weight(1f).fillMaxWidth().clipToBounds(),
        )
        Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
            Box {
                Column {
                    if (found == null && pasteOpen) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            OutlinedTextField(
                                value = pasted,
                                onValueChange = { pasted = it },
                                label = { Text(stringResource(R.string.finder_paste)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedButton(
                                onClick = {
                                    // The pasted link moves to the finder: the field is cleared so its URL is not left on screen.
                                    finder.paste(pasted)
                                    pasted = ""
                                    focus.clearFocus()
                                },
                                enabled = pasted.isNotBlank(),
                            ) { Text(stringResource(R.string.finder_use)) }
                        }
                        if (state.pasteError) {
                            Text(
                                stringResource(R.string.finder_paste_error),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp),
                            )
                        }
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (found != null) {
                            Text(
                                stringResource(R.string.finder_found),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Button(onClick = { onListenToThis(found) }) { Text(stringResource(R.string.finder_listen_to_this)) }
                        } else {
                            Text(
                                stringResource(R.string.finder_hint),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = togglePaste) {
                                Text(stringResource(if (pasteOpen) R.string.finder_paste_hide else R.string.finder_paste_toggle))
                            }
                        }
                    }
                }
                // A thin line over the top edge while a link is checked: the bar keeps its height.
                if (state.checking) LinearProgressIndicator(modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
    }
}

private const val BLANK = "about:blank"

/** Back goes to the previous page, but not to the blank page the finder starts on. */
private fun canGoBackToAPage(web: WebView): Boolean {
    if (!web.canGoBack()) return false
    val history = web.copyBackForwardList()
    val previous = history.currentIndex - 1
    return previous < 0 || previous >= history.size || history.getItemAtIndex(previous)?.url != BLANK
}

/** The screen's one WebView, outside Compose state: [BackHandler] and Go reach it through this. */
private class BrowserHolder {
    var view: WebView? = null
}

/**
 * The finder's browser: JavaScript and DOM storage on (players need them), no autoplay, no new windows, other schemes
 * than http(s) not followed, third-party cookies accepted (players are often embedded from another site). Remote
 * debugging is never turned on: the page's requests carry the owner's cookies.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun newBrowser(
    context: Context,
    background: Int,
    onRequest: (url: String, headers: Map<String, String>) -> Unit,
    onPage: (url: String) -> Unit,
): WebView = WebView(context).apply {
    setBackgroundColor(background)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.mediaPlaybackRequiresUserGesture = true
    settings.setSupportMultipleWindows(false)
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
    webViewClient = object : WebViewClient() {
        // Off the main thread: the finder's offer is thread-safe. The request goes on as the page made it.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            onRequest(request.url.toString(), request.requestHeaders.orEmpty())
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !isHttpUrl(request.url.toString())

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            url?.let(onPage)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            url?.let(onPage)
        }
    }
}
