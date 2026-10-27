package io.github.mickeiik.izle.companion.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import io.github.mickeiik.izle.companion.R
import io.github.mickeiik.izle.companion.home.resources
import io.github.mickeiik.izle.companion.ui.design.ButtonKind
import io.github.mickeiik.izle.companion.ui.design.Caption
import io.github.mickeiik.izle.companion.ui.design.IzleButton
import io.github.mickeiik.izle.companion.ui.design.IzleTheme
import io.github.mickeiik.izle.data.api.AdminCatalog
import io.github.mickeiik.izle.data.api.CatalogIssue

/** A reload the server refused: how many problems (its errors), each in a line; the catalog loaded before stays. */
@Composable
internal fun ReloadRefusedDialog(issues: List<CatalogIssue>, onDismiss: () -> Unit) {
    val errors = issues.filter { it.severity == "error" }.ifEmpty { issues }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (errors.isEmpty()) stringResource(R.string.catalog_reload_refused_none)
                else pluralStringResource(R.plurals.catalog_reload_refused, errors.size, errors.size),
                style = IzleTheme.type.heading,
            )
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.sm)) {
                for (issue in errors.take(MAX_ISSUES)) Caption(issueLine(issue))
            }
        },
        confirmButton = { IzleButton(stringResource(R.string.ok), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

/** About the catalog: name, id, build, built and loaded, counts, the resolver, the server's version, the warnings. */
@Composable
internal fun AboutDialog(catalog: AdminCatalog, onDismiss: () -> Unit) {
    val res = resources()
    val space = IzleTheme.spacing
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.catalog_about)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(space.md)) {
                for ((label, value) in aboutFacts(res, catalog)) Fact(label, value)
                Column(verticalArrangement = Arrangement.spacedBy(space.line)) {
                    Caption(stringResource(R.string.catalog_about_warnings))
                    if (catalog.warnings.isEmpty()) Text(stringResource(R.string.catalog_no_warnings), style = IzleTheme.type.body, color = IzleTheme.colors.textPrimary)
                    for (w in catalog.warnings.take(MAX_ISSUES)) Text(issueLine(w), style = IzleTheme.type.caption, color = IzleTheme.colors.warning)
                }
            }
        },
        confirmButton = { IzleButton(stringResource(R.string.ok), onClick = onDismiss, kind = ButtonKind.Quiet) },
    )
}

@Composable
private fun Fact(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(IzleTheme.spacing.line)) {
        Caption(label)
        Text(value, style = IzleTheme.type.body, color = IzleTheme.colors.textPrimary)
    }
}

/** At most this many issues are listed (as the admin page does). */
private const val MAX_ISSUES = 20
