# izle companion: design system

How every screen of the phone app looks. The rules for what the screens do are in [companion.md](companion.md) and
[companion-home.md](companion-home.md). The look is flat and quiet: neutral surfaces, hairline borders, one accent
used sparingly, colour only where it means something (online, a failing check), compact rows.

All of it lives in one package, `io.github.mickeiik.izle.companion.ui.design`:

- `Tokens.kt`: colours (light and dark), spacing, radii, sizes, type styles. The only file with colour, dp and sp
  literals for the look.
- `IzleTheme.kt`: maps the tokens onto `MaterialTheme` (colour scheme, typography, shapes), so plain Material 3
  components (dialogs, text fields, snackbars, menus) already follow them, and exposes the rest as
  `IzleTheme.colors`, `IzleTheme.spacing`, `IzleTheme.sizes`.
- `Components.kt` (split by kind if it grows): the components below. Screens build from these; they never style a
  Material component themselves.

A unit test fails when a file outside `ui/design` uses `Color(…)`, `RoundedCornerShape(…)`, `fontSize =`,
`FontWeight.`, `ButtonDefaults.`/`CardDefaults.` colours, or a `MaterialTheme.colorScheme` colour by name: screens use
tokens and components only. Layout dp values (a poster's size, a list's padding) come from `IzleTheme.spacing` and
`IzleTheme.sizes`.

## Tokens

### Colour

| Token | Dark | Light | Use |
|---|---|---|---|
| `background` | `#121316` | `#F6F7F9` | the page |
| `surface` | `#1A1B1F` | `#FFFFFF` | cards, sheets, bars |
| `surfaceMuted` | `#22242A` | `#EFF1F4` | section headers, the remote's buttons at rest, a poster's placeholder |
| `border` | `#2E3138` | `#DDE0E5` | hairlines (1 dp): card and button outlines, row dividers |
| `textPrimary` | `#ECEDEF` | `#1A1C1F` | titles, body |
| `textSecondary` | `#A2A6AE` | `#5D626B` | supporting lines, meta |
| `textMuted` | `#6F737B` | `#8B9098` | hints, placeholders, disabled |
| `accent` | `#5B9BFF` | `#1F6FEB` | the one primary action per screen, selection, links, the active tab |
| `onAccent` | `#0B1220` | `#FFFFFF` | text and icons on `accent` |
| `accentMuted` | `#5B9BFF` at 14 % | `#1F6FEB` at 10 % | selected choice, the listening bar |
| `success` / `successMuted` | `#4CC38A` / 14 % | `#1A7F4B` / 10 % | online, Works |
| `warning` / `warningMuted` | `#E3B341` / 14 % | `#9A6700` / 10 % | warnings, hidden on the TV |
| `danger` / `dangerMuted` | `#F47067` / 14 % | `#CF222E` / 10 % | Fails, Remove, Delete, errors |

No dynamic colour: the app looks the same on every phone. Light or dark follows the system. The brand's amber stays in
the launcher icon only.

### Spacing, radii, sizes

- Spacing (`IzleTheme.spacing`): `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24 dp. Page gutter `lg`; between blocks `lg`;
  inside a card `lg`; between a row's lines 2.
- Radii: `sm` 6 dp (chips), `md` 10 dp (buttons, cards, fields), `lg` 16 dp (bottom sheets' top corners).
- Sizes (`IzleTheme.sizes`): button height 40 dp, small button 32 dp, remote button 48 dp, list row min 56 dp, poster
  in a row 36 × 54 dp, poster on Now 56 × 84 dp, icon 20 dp, top bar 56 dp, bottom bar 64 dp.

### Type

| Style | Size / line | Weight | Use |
|---|---|---|---|
| `title` | 20 / 26 sp | Medium | the top bar, a sheet's title |
| `heading` | 16 / 22 sp | Medium | a card's title, a section header, a row's title |
| `body` | 15 / 21 sp | Regular | text |
| `label` | 14 / 20 sp | Medium | buttons, tabs, chips |
| `caption` | 13 / 18 sp | Regular | supporting lines, meta, hints (`textSecondary`) |
| `mono` | 12 / 16 sp | Regular, monospace | Sync details only |

Two weights only (Regular, Medium). Sentence case everywhere.

## Components

Every button label is centred, single line, and never pushed to an edge; equal-width groups share the width with
`weight(1f)`. Icons are Material icons (outlined where available) at 20 dp.

- **`IzleButton(text, onClick, kind, size, icon?)`**: `kind` Primary (accent outline and text, no fill: no button is
  ever filled; at most one per screen), Secondary
  (1 dp `border`, transparent), Quiet (text only, for "Edit", "Cancel"), Danger (danger text, 1 dp border); `size`
  Regular (40 dp) or Small (32 dp). Radius `md`. Full width only when it is the screen's single main action.
- **`ButtonRow` / `ButtonGrid(columns)`**: equal-width buttons with `sm` gaps (the timing nudges, the speed choice, a
  dialog's actions).
- **`ChoiceGrid(options, selected, columns)`**: equal-width choices; the selected one `accentMuted` fill with `accent`
  text and border (speed, a message's duration, Add show's kind filter).
- **`Card`**: `surface`, 1 dp `border`, radius `md`, padding `lg`. No elevation, no shadow, anywhere.
- **`ListRow(title, supporting?, badge?, leading?, trailing?, onClick?)`**: min 56 dp, `heading`-sized title
  (Regular weight for rows), one `caption` supporting line (ellipsised) with an optional `badge` (a `StatusChip`)
  after it, divider hairline between rows, padding `lg` horizontally; `titleTone` colours the title for a status
  (Activity's problems in `danger`).
- **`SectionHeader(title, meta?, trailing?)`**: `surfaceMuted` band, `heading` title on the left, the `caption` meta
  ("grid · 6") and an overflow icon button at the right edge.
- **`StatusChip(text, tone)`**: tone Success / Warning / Danger / Neutral, `*Muted` fill with the tone's colour as
  text, radius `sm`, `label` 12 sp. Shown only when it says something: on Home a row's line carries a chip for Works,
  Warnings and Fails, never for Not checked or Source changed.
- **`StatusLine(tone, text)`**: a 8 dp dot in the tone's colour then `caption` text ("Online", "Offline · seen 5 min
  ago").
- **`Poster(url, size)`**: radius `sm`, `surfaceMuted` placeholder, `ContentScale.Crop`, coil.
- **`ActionRow(icon, text, tone?, onClick)`**: a sheet's action as a row (icon + text, 52 dp), Danger tone in
  `danger`. Sheets list actions as rows, never as stacked buttons.
- **`Disclosure(title, summary, expanded, onToggle) { content }`**: a folded section with a chevron (Timing for this
  source, Sync details).
- **`RemoteBar`**: one row of 48 dp square-ish outlined buttons (radius `md`, 1 dp `border`, `textPrimary` icons);
  Play/Pause is outlined and drawn in `accent`. The seek buttons read "−30" and "+30".
- **`IzleSheet`**: `ModalBottomSheet` with `surface`, top radius `lg`, title in `title`, content padded `lg`.
- **`IzleTopBar(title, onTitleClick?, actions)`** and **`IzleBottomBar`** (64 dp, icon + `label`, active in `accent`,
  no pill indicator fill beyond `accentMuted`); Now's tab icon is a TV, Home's a grid, Catalog's a stack of books, the
  TV tab's sliders (`IzleIcons.Tune`). A `TabItem`'s `dot` draws an 8 dp `danger` dot at its icon's top end (the TV has
  problems).
- **`SearchField(value, onValueChange, placeholder)`** (`Filters.kt`): an outlined field, radius `md`, on `surface`, a
  search icon, the placeholder in `textMuted`, one line, a clear button while it holds text.
- **`FilterChip(text, selected)`** in a **`ChipRow`**: 32 dp, radius `sm`, `label`; at rest a 1 dp `border` and
  `textSecondary` text, selected in `accentMuted` with `accent` text and border. The row is one line that scrolls
  sideways, chips `sm` apart, from the page gutter (the Catalog's filters, What's new's builds).
- **`QuietSelect(text, items)`**: a choice inside a line of text (a list's sort): the current choice in `label`,
  `textSecondary`, a chevron, and a menu with the current item ticked.
- **`EmptyState(text)`**: `caption`-coloured body text, no card around it.
- **`IzleSwitch(checked)`** (`Controls.kt`): an on/off switch in a row's trailing slot, the row taking the tap; on, an
  `accent` track with a `surface` thumb; off, `surfaceMuted` with a 1 dp `border` and a `textMuted` thumb.
- **`Chevron`**: a row that opens something ends with it (20 dp, `textMuted`).
- **`FactRow(label, value, mono?)`**: one fact of a sheet: the label in `caption`/`textSecondary` in a 72 dp column,
  the value in `body` (or `mono`) beside it, wrapping, padded `lg`.

## Screens

The approved mockups are the reference: compact, one primary action per screen, colour only for status.

- **Now**: `StatusLine`; what plays straight on the page, no card: `Poster` (56 × 84) beside the title, the episode
  ("S1 · E3 — The gate") and the progress (`LinearProgressIndicator` 4 dp, `accent` on `surfaceMuted`) with
  `12:04 / 30:10 · playing` in `caption`; "Nothing is playing" is an `EmptyState` line; `RemoteBar`; **Stop the TV**
  and **Listen along** (headphones icon) side by side; while listening, Stop the TV alone and the listening bar (a `Card` in `accentMuted`:
  headphones icon, "Listening · in sync" in `accent`, the source, **Stop** Small) with "Tap the bar for source and
  timing" centred under it; a hairline; **Send a message to the TV** (Secondary, full width). The message sheet: the
  field with its counter, "Show for" and a `ChoiceGrid(3)`, then **Cancel** and **Send** (Primary) at the right.
- **Home**: a header line "Grid 4 × 2 · 6 shows" in `caption` with the Home options icon; sections as
  `SectionHeader`s; shows as `ListRow`s (`Poster` 36 × 54, title, one supporting line "Film · watched, starts over"
  with the verdict's chip as its badge, the dotted drag handle as trailing in `textMuted`); hidden shows with
  `warning` supporting text and **Remove** (Small, Danger). Under the list, above the tabs: **+ Section** (Secondary)
  and **+ Add show** (Primary), equal width.
- **Show sheet**: a header with the `Poster`, the title in `title` and one caption "No title · card 2 of 4 · S1 · E3
  · new" (and the verdict as a `StatusLine` once checked), a hairline, then `ActionRow`s.
- **Add show**: search field, kind `ChoiceGrid` (3), "Add to" as a Secondary button with the section and a chevron,
  results as `ListRow`s with an **Add** Small Secondary button.
- **Listen along** (top bar: back arrow and "Listen along"): context `caption` line; "Source" in `heading`, then radio
  `ListRow`s, the kind as a Neutral chip, the found link's row with **Find** (Small) at its end; **Listen** (Primary,
  headphones icon, full width, the one primary of the screen; Stop is Danger); Earphone delay as a `ListRow` ("kept
  on this phone") ending with **−**, the value and **+**; `Disclosure`s for
  Timing and Sync details; inside Timing: `ButtonRow` (Mark on TV, Mark on phone), the offset readout (`title`,
  monospace digits) with **Edit** (Quiet), `ButtonGrid(3)` nudges, `ChoiceGrid(2)` speed, `ButtonRow` (Save timing and
  Apply to all episodes, both Secondary: Listen is the screen's primary).
- **Catalog**: the `SearchField`, the filters as one `ChipRow`, then the list: the What's new `ListRow` (the sparkle
  icon in `accent`, "25 Oct · 3 shows, 12 episodes", a chevron), the count line ("142 shows" in `caption`, the sort
  as a `QuietSelect` and the tab's ⋮ at the right), and the shows as `ListRow`s (`Poster` 36 × 54, "Series · 2013 ·
  3 episodes", "On Home" in `caption`/`textMuted` as trailing). **What's new** (top bar: back arrow, "What's new", a
  refresh icon): the builds as a `ChipRow`, the build's `caption` summary, then `SectionHeader`s; new shows end with
  **Add** (Small, Secondary) or "On Home"; gone shows in `textSecondary`.
- **TV** (the fourth tab, [companion-tv.md](companion-tv.md)): one scrolling page, no card anywhere. **Problems** as a
  `SectionHeader` ("3 today" as meta, **Clear** Quiet Small at its right), the newest five as `ListRow`s (the title in
  words, "Caminandes · S1 · E2 — Gran Dillama · 2 h ago", the kind as a Neutral `StatusChip` badge), "All 12 problems"
  with a `Chevron`, or "No problems recorded." as an `EmptyState`; the **Activity** row ("What happened on Salon, live",
  a `Chevron`); **TV app** (`SectionHeader`): "izle 0.6.1 · Android 12" with the update state's chip as trailing
  (Success, Neutral, Warning; none when unknown), how it installs updates in `caption` under it, **Update now**
  (Secondary, Small); **Settings** (`SectionHeader`): `ListRow`s with the value as supporting text, Play on start with
  an `IzleSwitch`; **Forget this TV** as a Danger `ActionRow` at the end. Choices open an `IzleSheet` of radio
  `ListRow`s; Name, Clear and Forget are dialogs (the confirm Danger or Primary, Cancel Quiet). A problem's sheet: the
  title, its `caption` ("Today 14:05 · reported by the server") and the code in `mono`, a hairline, `FactRow`s, the
  check's `StatusLine`s once it answers, a hairline, then `ActionRow`s.
- **TV list, Phones, Connect, link finder**: `ListRow`s and the same buttons; Connect's **Connect** is its Primary.
