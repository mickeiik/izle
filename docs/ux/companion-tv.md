# izle companion: the TV tab, Activity and pairing

The fourth tab of a TV's page (Now, Home, Catalog, **TV**): what went wrong on this TV, its app, its settings, and
what happened on it lately; and, on the TV list, pairing a new TV from the phone. The look is the design system's
([companion-design.md](companion-design.md)); the routes are in the [server API](../spec/server-api-v1.md#devices)
(Devices, Problem reports, Events, Pairing, Replacing a TV). No server change.

## The tab

The bottom bar's fourth item, **TV** (the tune icon: sliders), carries a small `danger` dot while the TV has problems
from the last 24 hours (`problems.recent` > 0 in the TV list's device).

From the top, one scrolling page:

- **Problems** (a `SectionHeader`, meta "3 today" for `recent`, **Clear** at its right while there are any): the
  newest five as `ListRow`s: the title in words ("The source refused (403)"), supporting "Caminandes ·
  S1 · E2 — Gran Dillama · 2 h ago", and the kind as a Neutral `StatusChip` badge (Playback, Resolve, Proxy, Network,
  Other). Then "All 12 problems" (a row with a chevron) when there are more; it opens the full list (up to 100) in
  the same rows. None: "No problems recorded." (`EmptyState`). **Clear** asks first ("Forget this TV's problems?").
- **Activity** (one `ListRow`, a chevron): "What happened on Salon, live", supporting the newest event in words. It
  opens Activity.
- **TV app** (a `SectionHeader`): one row "izle 0.6.1 · Android 12" with the update state at its right as a chip
  (Up to date: Success; Update available: Neutral; Needs an update: Warning; unknown: none), a caption line on how
  the TV installs updates ("Installs updates by itself while nobody watches." / "Needs someone at the TV to press OK."),
  and **Update now** (Secondary, Small) when the state is `pending` or `needs_install_now` (the `update` command; its
  result in a snackbar with the shared command wording; `409 no_apk`: "The server has no TV app to offer.").
- **Settings** (a `SectionHeader`): rows that open a choice, each showing its value as supporting text:
  - **Name** ("Salon"): a dialog with the field (1–60 characters), Cancel and Save.
  - **Menu language** ("English"): Türkçe or English (`uiLanguage`).
  - **Audio** ("Server default · Türkçe" or "English"): Server default, then the languages the admin page offers.
  - **Subtitles** ("Off" or a language): Off, then the same languages.
  - **Play on start** (a switch in the row's trailing slot): `autoplayOnStart`.
  Each change is a `PATCH` at once; the row shows the new value, or a snackbar with the error and the old value.
  A choice opens an `IzleSheet` with radio `ListRow`s (the current one selected).
- **Forget this TV** (`ActionRow`, Danger) at the end: a dialog "Forget Salon? It has to pair again to play. Its
  history stays." → `DELETE`; then the TV list.

The tab reads `GET …/devices/:id` and `GET …/problems?limit=100` (all a TV keeps, for "All 12 problems") when shown and again after a change; it follows
`problem.recorded`, `device.updated` and `device.app_version` events for this TV (a long-poll while the tab is shown,
as Home follows its events).

## A problem's sheet

Tap a problem: an `IzleSheet`.

- Title: the problem in words; caption "Today 14:05 · reported by the TV" (or "by the server") · the code
  (`ERROR_CODE_IO_BAD_HTTP_STATUS`, in `mono`).
- Rows of facts, each a label and a value, only those it has: **Show** (the title, or "no longer in the catalog"),
  **Episode**, **Source**, **At** (position, `formatClock`), **HTTP** (status), **App** (version), **Detail** (the
  redacted text, as is).
- Actions (`ActionRow`s): **Check this episode now** (`POST …/diagnostics/resolve` with the episode, or the item for a
  channel; the verdict as a `StatusLine` under the facts once it answers, in the words of the catalog's source rows)
  and **Open the show** (the show's page from the Catalog slice). Neither when the problem has no item, or it is
  missing.

Titles in words, by `kind` · `code` (an unknown code shows as it is):

| Code | Words |
|---|---|
| `no_playable_source` | Nothing could play |
| `source_failed` | A source failed, another played |
| `upstream_401`, `upstream_403`, `upstream_410` | The source refused (403) |
| `upstream_error` | The source broke off |
| `upstream_unreachable` | The source did not answer |
| `not_a_playlist`, `playlist_too_large`, `not_media` | The source sent something unplayable |
| `egress_denied` | The server refused the source's address |
| a TV `playback` code (`ERROR_CODE_…`) | Player error: the code's words in lower case ("io bad http status") |
| `network` kind | The TV lost the server |

## Activity

Full screen over the tabs (back arrow, "Activity"), like a show's page. This TV's event log, newest first, live.

- A `ChipRow` filter: **Everything**, **Playing**, **Remote**, **Home**, **Problems**, **Connection** (one at a time).
- Day bands (`SectionHeader`: "Today", "Yesterday", "Mon 26 Oct") and rows: the time in `caption` at the left
  ("14:05"), the event in words as the title, a supporting line when it has one; who did it at the end of that line
  ("· your phone", "· Pixel 8", "· admin page", "· a token: Home bot", "· the TV" for the remote).
- Words (`Event.type`):
  - `playback.started` "Started Caminandes · S1 · E2" (supporting "from 4:10 · OK on Home" / "· played from a phone");
    `playback.ended` "Stopped at 12:04" (or "Watched to the end"); `playback.stalled` "Stalled at 12:04";
    `episode.seen` "Marked seen: S1 · E2".
  - `command.sent` "Sent: play" / "Sent: a message", `command.result` "Couldn't play: …" only when it failed.
  - `home.changed` "Home changed · +1 show, +1 app, −1" (the shows and app cards that left counted together);
    `cursor.changed` "Continues from S1 · E3"; `device.updated` "Settings changed: name, audio".
  - `problem.recorded` "Problem: The source refused (403)" (danger tone); `check.finished` "Home check: 2 fail".
  - `device.online` "Online", `device.offline` "Offline", `device.paired` "Paired", `device.app_version` "App 0.6.0 →
    0.6.1", `phone.connected` "Phone connected: Pixel 8", `catalog.reloaded` "Catalog reloaded · +3 shows".
  - Other types are not shown.
- The noisy types are not fetched (`types` lists only those above). The log reads `GET /admin/events?devices=<tv>`
  from the start of the kept log (`after=0`), page after page (500 each) up to the newest, keeps the newest 300, then
  long-polls for more while the screen is shown. `gap` re-reads.
- Empty: "Nothing yet."

## Pairing a TV from the phone

On the TV list (the screen the TV's name in the app bar opens):

- Each TV's row gains its state in the supporting line: "Online · playing Caminandes", "Offline · seen 2 h ago", and
  "· 1 problem" (warning tone) when `problems.recent` > 0.
- While a code waits (`GET /admin/pair/pending`, read with the list and every 10 s while the list is shown): a `Card`
  above the TVs: "A TV is waiting to pair", the code in `digits` ("483 920"), "8 min left" in
  `caption`, then **Not mine** (Quiet: `DELETE …/pending/:code`, after a confirm) and **Approve…** (Primary). A code
  already approved shows "Approved as Kitchen · waiting for the TV" instead of the buttons.
- Under the TVs: **Pair a new TV by its code** (Secondary, full width): a dialog with the 6-digit field, then the same
  approve form.
- **Approve** (an `IzleSheet`): "Code 483 920"; the name field ("TV 2" placeholder: the server names it when empty);
  "This TV is" with a `ChoiceGrid`: **A new TV** and one choice per active TV ("Replaces Salon"); then Cancel and
  **Approve** (Primary). Errors in words: `404 unknown_code` "No TV shows this code (it may have expired).",
  `409 already_approved` "This code was approved already.". After approving, the list reloads.
