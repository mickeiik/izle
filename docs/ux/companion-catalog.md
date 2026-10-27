# izle companion: the Catalog tab

The third tab of a TV's page (Now, Home, **Catalog**): the server's catalog, seen from that TV, so adding and playing
always mean "on this TV". The look is the design system's ([companion-design.md](companion-design.md)); the routes are
in the [server API](../spec/server-api-v1.md#catalog). Catalog bundles are read-only: the phone browses, adds, plays,
checks and reloads; it never edits titles, episodes or sources.

## The tab

- A search field ("Search the catalog"), then filter chips in one scrolling line: **Films**, **Series**,
  **Channels** (any of them; none chosen: every kind), **New** (what the newest catalog build added: `since` = that
  build's `loadedAt`) and **Not on Home** (`notOnDevice` = this TV). Typing searches after a short pause.
- A **What's new** row above the results (sparkle icon in `accent`): "25 Oct · 3 shows, 12 episodes" from the newest
  build that is not the baseline; absent when there is none. It opens What's new.
- A line with the count ("142 shows") and the sort at its right (**Title**, **Newest**, **Year**; a menu).
- Results as rows: poster, title, "Series · 2013 · 3 episodes" (· "2 new" with **New**), and "On Home" in `textMuted`
  at the end when this TV has it; channels read "Channel". Pages of 50 load as the list scrolls. A tap opens the show.
- The tab's ⋮: **Reload catalog** (re-reads the bundle on the server: progress, then "Catalog reloaded: build 7f3a.
  Every TV refreshes its Home." or "The catalog has 3 problems; the one loaded before stays." with the issues listed
  in a dialog) and **About the catalog** (a dialog: name, id, build, built and loaded, counts, the resolver, the
  server's version, warnings).
- Empty results: "Nothing matches." / with Not on Home: "Everything that matches is on Home already."

## A show's page

Full screen over the tabs, with a back arrow and the show's title in the top bar.

- Head: poster (56 × 84) beside the title, "Series · 2013 · Animation" (kind, year, genres), the original title
  when it differs, and the synopsis clamped to three lines (tap: all of it).
- **On Home** (a check icon; tap: a menu to **Remove from Home**) or **Add to Home** (to the untitled section; a long
  press or its chevron: choose the section), beside **Play on Salon** (the screen's primary, outlined: what OK plays
  for this show on this TV, or the channel). A channel the catalog does not allow to play shows "Playback not allowed
  by the catalog" instead of Play.
- **Episodes** (a series; a film's single episode and a channel are shown as **Sources** directly): a section band
  with **Check all** at its right; rows "S1 · E1 — Llama Drama", supporting "1:30" plus, on this TV, "OK plays this"
  in `accent` for the episode OK plays next, "new" for one the newest build added, and the check chip (Works,
  Warnings, Fails). "Episodes advance on their own." / "…do not advance…" under the list.
- A running check shows the Home tab's check strip at the top (the same component), and the chips update when it
  ends.
- Tap an episode: its sheet.

## An episode's sheet

- Title "S1 · E2 — Gran Dillama", caption "2:26 · 2 sources · checked 3 h ago" (or "not checked").
- Action rows: **Play this on Salon** (`play` with the episode), **Salon continues from here** (sets the cursor:
  snackbar "Salon continues Caminandes from S1 · E2."), **Check this episode** (`POST …/diagnostics/resolve`, the
  rows below update when it answers).
- **Sources, in the order the TV tries them** (a section band): one row per source: its id and kind ("main · HLS ·
  proxied"), audio languages and what the last check found in one line ("audio en, tr · 1080p", or the failure in
  words: "no range: seeking breaks", "not media", "timeout at segment"), and the verdict chip. Read from
  `GET …/checks/playables/:id`; never URLs or headers (the server does not give them).
- Not allowed to play: "Playback not allowed by the catalog" and no Play or Continue rows.

## What's new

From the **What's new** row; a back arrow, "What's new", and a refresh icon.

- The builds as choice chips, newest first ("25 Oct", "18 Oct", …; the baseline last, "First loaded").
- For the chosen build: "Build 7f3a · loaded 25 Oct 09:12 · +3 shows, +12 episodes, −1 show".
- Section bands **New shows** (rows with poster and **Add**, or "On Home"), **New episodes** (by show: the show's
  title, the episodes' names; a tap opens the show), **Gone** (titles in `textSecondary`). Empty sections are left
  out; a build that changed nothing says so.
