# Admin page: a TV's Home screen

How the owner arranges one TV's Home on the admin page (`/admin/`, a TV's **Home screen** tab). What the viewer sees
is in [Senior TV experience](senior-tv.md#home); the routes are in the
[server API](../spec/server-api-v1.md#home-sections).

Status: sections are **specified, not implemented** (2026-10-22); the rest describes the tab as it is.

## The screen

- The tab draws the TV's Home to scale (960 × 540 dp, scaled to the page's width) from the TV app's own numbers:
  the same cards, chips, progress bars and titles, and with sections the same section titles, lines between sections
  and scrolling lines. Further lines scroll inside the screen as on the TV, a scrolling line sideways.
- Columns and rows sit above the screen; a new size is previewed on the screen before **Save grid** (or **Undo**).
- What the TV hides (missing from the catalog, not playable) is listed under the screen, each with its section and
  **Remove**.
- A section the TV does not show because nothing in it can play is drawn on the screen as its title over an empty
  dashed band, "Empty: not shown on the TV", so the owner can see it and fill it. Only the admin page draws it.

## The selected card

- Select a card by clicking it, or move between cards with the arrow keys as on the TV: ↑ and ↓ line by line across
  sections, ← and → along a line. Enter does not play: a stray key would start something on someone's TV.
- The panel under the screen shows the card: where it is ("Films · card 3 of 6 · row 1, column 3", "Channels · card
  5 of 6", or "No title · card 2 of 3" in the untitled section), what OK plays, **Play**, **Episodes…** for a series,
  and **Remove from Home**.
- **Move**: ◀ and ▶ along its section; ▲ and ▼ a row up or down within a grid section (off at the section's first and
  last row); **Move to first**: the first place of its section; **Section**: a list of the sections by title (the
  untitled one as "No title") that moves the card to the end of the chosen one. The card stays selected wherever it
  goes.

## Sections

A **Sections** list next to the screen (under it on a narrow page) holds the sections in their order on the TV, the
untitled section among them:

- Each section shows **↑** and **↓** to move it, its title in a text field (saved with Enter or on leaving the field;
  a blank title is put back), **One scrolling line** (on: layout `row`, off: `grid`), and how many shows it holds
  ("6 shows", "Empty").
- The untitled section reads "No title · shows in no section". It has no title field and cannot be deleted; it can
  be moved and made a scrolling line like the others.
- **Delete** (titled sections only) asks in place, "Delete Films? Its 6 shows move to No title.", with **Delete** and
  **Keep**. Deleting a section never takes a show off Home.
- **Add section**: a title field and **Add** at the end of the list; the new, empty section goes at the end of Home
  and its title field takes the focus. With 20 sections besides the untitled one, the field gives way to "A Home holds
  at most 20 sections."
- Choosing a section in the list scrolls the screen to it.

## Add shows

- The catalog browser under the screen adds a show to the end of the section chosen in **Add to** above the results:
  "No title" (the untitled section) unless the owner picks another; the choice stays while the tab is open. The
  message names it: "Sintel added to Films."
- A show already on Home reads "On Home", whatever its section: a show is in one section at a time, and the
  selected card's **Section** moves it.

## Saving

- Every change saves at once and the screen redraws from the server's answer; there is no Save button except the
  grid's. While a change is being saved, further edits wait for it.
- Each edit is one [single change](../spec/server-api-v1.md#home-list-changes) on the server (add, move, remove, or
  one section's title, layout or place), never the whole Home sent back, so an edit made elsewhere at the same time
  (another page, an agent) is not undone. The screen follows such edits as it follows the TV.
