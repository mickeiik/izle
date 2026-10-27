# Companion app: a TV's Home

How the owner arranges one TV's Home from the phone (the **Home** tab of a TV's page in the companion app). It is
the phone's take on the [admin page's Home screen](admin-home.md): the same words and rules, as a list instead of a
scaled screen. The rest of the TV's page is in [Companion app](companion.md); what the viewer sees is in
[Senior TV experience](senior-tv.md#home); the routes are in the [server API](../spec/server-api-v1.md#home-sections).

## The list

- A top line says the grid and the count: "Grid 4 × 2 · 24 shows"; its ⋮ holds **Grid size** and **Check Home…**. Under it, **Add show**
  and **+ Section**, side by side, equal widths.
- Each section is a header row in its order on the TV: its title ("No title" for the untitled one), its layout and
  count of cards ("grid · 6", "row · 5"; app cards count) and a ⋮ menu. A section without cards reads "Empty: not
  shown on the TV".
- Each show is a row: poster, title, one line with what OK plays ("S1 · E5 · continues at 12:04 of 30:10", "Film",
  "Live") and "· N new" when the series has new episodes, a chip only when its last check needs attention
  (**Fails**, **Warnings**; the sheet says the verdict in full), and a drag handle.
- A show the TV hides is greyed with why: "Hidden: not in the catalog" (its id stands in for the title it
  no longer has) or "Hidden: can't play", with **Remove**.
- An [app card](../spec/server-api-v1.md#app-cards) is a row like a show's: the app's picture (drawn whole in the
  poster's place, so that the titles line up; the apps icon without one), its name, "App" as its line, and a drag
  handle; greyed "Hidden: not installed on the TV" with **Remove** when the TV no longer has it.
  Its sheet: where it is, "OK opens <name> on Salon", **Move to section…**, **Move to first**, **Remove from Home**.
  It moves (drag, sheet) with `…/home/apps/:appId` as a show does with `…/home/items/:itemId`.
- The top line counts the app cards too: "Grid 4 × 2 · 24 shows · 3 apps".
- With nothing on Home: "Nothing on Home yet. Add a show and it appears on the TV."

## Moving shows

- Drag a show by its handle, or long-press its row and drag, within a section or into another one; the list scrolls
  when the show is held past its top or bottom. Over another show it takes that show's place; over a section's header
  it enters that section first (coming from above) or goes to the end of the section above (coming from below); over
  an empty section it becomes its first show.
- On release the move is one `PATCH …/home/items/:itemId` with the section and the position it landed at, as the
  server counts it (within that section, once taken out of where it was). A drop where it started sends nothing.
- While a change is being saved, a new drag does not start.

## A show's sheet

Tapping a show opens a sheet:

- Where it is ("Films · card 1 of 6"; "No title · card 3 of 4"), what OK plays and its check.
- **Play on Salon now**: the TV plays what OK plays for it. The message says what happened within a few seconds:
  "Sintel is playing on Salon.", "Salon could not play Sintel.", "Salon isn't ready (it shows its pairing screen).",
  "Sent to Salon." (no result yet), or, offline, "Salon is offline. It gets this if it connects in the next 2
  minutes."
- **Continue from episode…** (a series): the episodes that may be played, the one OK plays now marked; choosing one
  sets the TV's place ("Salon continues Sintel from S1 · E5 — Rain.", the episode named as in the list), starting that episode from its beginning.
- **Check this show**: every episode of it that may play (or the channel), in the [check strip](#checks).
- **Move to section…** (the sections, the current one marked "here now"): to the end of the one chosen. **Move to
  first** of its section (not for the first one).
- **Remove from Home**.
- A show the TV hides offers only the moves and **Remove from Home**.

## Sections

- The ⋮ of a section: **Rename** (a dialog, 1–40 characters; titled sections only), **One scrolling line** (checked
  when the layout is `row`), **Move up**, **Move down**, **Delete** (titled sections only).
- **Delete** asks: "Delete Films?" "Its 6 shows move to No title." ("Its 7 cards move to No title." when app cards
  are among them; "It holds no shows." when empty), **Delete** / **Keep**.
- **+ Section** asks for a title and adds the section at the end of Home. With 20 sections besides the untitled one,
  the dialog says "A Home holds at most 20 sections." instead.

## Add show

- A screen over the whole app: a search field, the kind chips **Films**, **Series**, **Channels** (none chosen: every
  kind), **Add to** (the sections by title, "No title" unless the owner picks another; the choice stays while the
  tab is open) and the results, 50 at a time as the list is scrolled.
- The search leaves out what is on this TV already and what cannot play; it runs 0.3 s after the last key.
- **Add** puts the show at the end of the chosen section and takes it off the results: "Sintel added to Films." (or
  "Sintel added to Home." for the untitled section). With nothing found: "Nothing found that Salon does not have on
  Home already."
- A fourth kind chip, **Apps**, lists instead the apps the TV reported that are not on Home yet (picture, name,
  **Add**), in the TV's order, those whose name holds the search text (at once, no server search); none chosen lists
  shows only. **Apps** and the show kinds exclude each other: choosing one lets go of the other. The field reads
  "Search the apps". **Add** puts an app card at the end of the chosen section: "Weather added to Films." A TV that
  never reported: "Salon has not listed its apps yet. Its izle app may need an update." With no app left to add: "No
  apps to add."; with none matching the search: "No app found that Salon does not have on Home already."

## Checks

The phone's take on the [admin page's checks](admin-home.md#checks), with its words; the routes are the
[server API's checks](../spec/server-api-v1.md#checks).

- **Check Home…** (the top line's ⋮) opens a sheet with **Quick: what OK plays** (per show, the episode OK plays; a
  channel itself) and **Full: every episode** (every episode that may be played, and the channels), under a muted
  note: a pass means the server reached real media along the TV's path just now; it does not prove the TV can decode
  the codecs. A show's sheet has **Check this show**.
- While a check runs, a strip at the top of the list says what it checks ("Home of Salon, quick", or the show's
  title), "12 of 40 checked · 1 failing" (and "· 2 with warnings", "· 1 skipped"), a bar, and **Stop**. The tab
  follows a check already running for this Home or one of its shows when it opens.
- When it ends, the strip shows its result for a few seconds (or until closed): "Done: 40 checked · all work" (or what
  failed, the dot in the verdict's colour) or "Stopped: 12 of 40 checked", and what was skipped and why ("Skipped:
  Sintel (missing from the catalog)."). Home is read anew on `check.finished`, as on every event, so the rows' chips
  show what it found.
- One check runs at a time on the server: starting another follows the one going and says "A check is already
  running: Home of Salon, quick". A refusal is said in words ("Nothing to check: no episode or channel there may be
  played.").

## Grid size

The ⋮ of the top line opens **Grid size**: columns 3–10 and rows 1–4 with − and + buttons, **Save** (only when
changed) and **Cancel**. It is the one `PATCH …/devices/:id` the tab makes.

## Saving and following

- Every change saves at once, as one [single change](../spec/server-api-v1.md#home-list-changes) (add, move, remove,
  or one section's title, layout or place), never the whole Home. The list shows a move, a removal, a rename or a
  layout at once and redraws from the server's answer; a progress bar shows while it is saved. Changes made quickly
  one after another are saved in order.
- When the server refuses a change because Home is not what the phone showed (`home_changed`, `not_on_home`,
  `unknown_section`), the tab reads Home anew and says "Home changed on another screen; this is the current one."
  Other refusals are said in words ("A Home holds at most 200 shows.", "The server cannot be reached.").
- While the tab is shown it follows the server's event log for this TV (`home.changed`, `cursor.changed`,
  `device.updated`, `device.apps`, `catalog.reloaded`, `check.finished`, or a gap) and reads Home anew on each, so edits made
  elsewhere (the admin page, another phone, an agent) show up and are never undone.
- When Home cannot be read the first time, the tab says so with **Try again**; later failures keep what is shown.

## Buttons

Labels are one line and centred in their buttons: the two buttons under the top line share the width equally, the
sheet's buttons span it, and the layouts hold at 360 dp.
