# Admin page: a TV's Home screen

How the owner arranges one TV's Home on the admin page (a TV's **Home screen** tab). What the viewer sees is in
[Senior TV experience](senior-tv.md#home); the routes are in the [server API](../spec/server-api-v1.md#home-sections).

## The screen

- The tab draws the TV's Home to scale (960 × 540 dp, scaled to the page's width) from the TV app's own numbers: the
  same cards, chips, progress bars, titles, section titles, lines and scrolling lines, scrolling as on the TV.
- Columns and rows sit above the screen; a new size is previewed before **Save grid** (or **Undo**).
- What the TV hides (missing from the catalog, not playable) is listed under the screen, each with its section and
  **Remove**. A section the TV does not show because nothing in it can play is drawn as its title over an empty dashed
  band, "Empty: not shown on the TV".

## The selected card

- Select a card by clicking it, or move with the arrow keys as on the TV (↑ ↓ line by line across sections, ← →
  along a line, Home and End to the first and last card). Enter does not play, so a stray key starts nothing.
- The panel under the screen shows where the card is ("Films · card 3 of 6 · row 1, column 3" in a grid, "Channels ·
  card 5 of 6" in a scrolling line; the untitled section reads "No title"), what OK plays, **Play**, **Episodes…** for
  a series, and **Remove from Home**.
- **Move**: ◀ and ▶ along its section; ▲ and ▼ a row within a grid section (off at its first and last row); **Move to
  first** of its section; **Section**: the sections by title ("No title" for the untitled one), moving the card to the
  end of the chosen one. The card stays selected wherever it goes.

## Sections

A **Sections** list next to the screen (under it on a narrow page) holds the sections in their order on the TV:

- Each shows **↑** and **↓**, its title in a text field (saved with Enter or on leaving it; a blank title is put
  back), **One scrolling line** (layout `row`, else `grid`), and how many shows it holds ("6 shows", "Empty").
- The untitled section reads "No title · shows in no section", has no title field and cannot be deleted.
- **Delete** (titled sections) asks in place: "Delete Films? Its 6 shows move to No title.", **Delete**, **Keep**.
- **Add section**: a title field and **Add** at the end of the list; the new, empty section goes at the end of Home
  and its title field takes the focus. With 20 sections besides the untitled one: "A Home holds at most 20 sections."
- Choosing a section in the list scrolls the screen to it.

## Add shows

- The catalog browser under the screen adds a show to the end of the section chosen in **Add to** ("No title" unless
  the owner picks another; the choice stays while the tab is open). The message names it: "Sintel added to Films." (or
  "added to Home." for the untitled section).
- A show already on Home reads "On Home", whatever its section; the selected card's **Section** moves it.

## Saving

- Every change saves at once and the screen redraws from the server's answer; only the grid has a Save button. While a
  change is being saved, a title or layout edit waits for it; other edits are ignored.
- Each edit is one [single change](../spec/server-api-v1.md#home-list-changes) (add, move, remove, or one section's
  title, layout or place), never the whole Home sent back, so an edit made elsewhere (another page, an agent) is not
  undone. The screen follows such edits as it follows the TV.
