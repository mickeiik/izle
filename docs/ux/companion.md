# izle companion: a TV's page on the phone

How the owner's phone app (`android/companion`) shows one TV: what it plays, a remote, a message, and Listen along.
Its Home tab is in [The companion's Home tab](companion-home.md), the Catalog tab in [companion-catalog.md](companion-catalog.md), the TV
tab, Activity and pairing in [companion-tv.md](companion-tv.md); the routes are in the
[server API](../spec/server-api-v1.md). The TV itself never changes for the phone: what the viewer sees is in
[Senior TV experience](senior-tv.md).

## Getting there

- Connect (the TV's code or its QR code) → the TV list → a **TV page**. A phone connected from a TV opens that TV's
  page at once; with a typed token and a single TV, so does the list.
- The TV list shows each TV's name and whether it is online ("Online", "Last seen 5 minutes ago").
- The TV page's app bar holds the TV's name (tap it to switch TV: the list) and the ⋮ menu: **Phones**, **Disconnect
  this phone**, **Clear browser cookies**.
- A bottom bar switches between **Now** and **Home**. Back goes to the TV list when the server has more than one TV;
  with one, it leaves the app. Going to the list does not stop listening; picking another TV does (listening follows
  the TV it started with).

## Now

- The first line says whether the TV is online: "Online", or "Offline · seen 5 minutes ago".
- What plays: the title, the episode, a progress bar and `12:04 / 30:10 · playing` (or `paused`, `starting`), moved on
  once a second from the TV's anchor while it plays; a channel reads "Channel · playing". Nothing active (nothing
  reported, stopped, or no report in 2 minutes, or the TV offline): "Nothing is playing".
- The tab follows `GET …/now?seq=&wait=25` while it is shown, so a pause, a seek or another episode shows within a
  round trip; it stops following when the tab, the page or the app is left.
- Under it, while this phone listens to this TV, the **listening bar**: "Listening · in sync" (or `catching up`,
  `waiting`, `paused`, `starting`), the source, and **Stop**; tapping the bar opens Listen along. Otherwise a **Listen
  along** button, or one line saying why not: "Nothing to listen to: Salon is on a channel." / "Nothing to listen to:
  Salon isn't playing anything."

## Remote

- One row of five equal buttons, icons with spoken names: Previous episode, Back 30 seconds, Play or Pause (as the TV
  plays), Forward 30 seconds, Next episode. A channel has no seek or pause: two buttons, **Previous channel** and
  **Next channel**. Then **Stop the TV** (back to its Home).
- Each press sends one [command](../spec/server-api-v1.md#commands), then reads its result every 500 ms for up to
  5 s, and says something only when worth saying:
  - the TV is offline: "Salon is offline. It gets this if it connects in the next 2 minutes." (no result is read);
  - `ignored` or `failed`, in words: "Nothing is playing on Salon.", "No next episode." / "No previous episode.", "No
    channel after this one on Home.", "A channel can't be paused or skipped through.", "Salon isn't ready (it shows
    its pairing screen).", others "Salon couldn't do that (the player failed)." / "Salon didn't do that (…).";
  - `done`, or no result within 5 s: nothing.

## Send a message

- **Message** (beside **Stop the TV**) opens a bottom sheet: the text (1–200 characters, trimmed, with a counter), **Show
  for** 15 s, 1 min (the default) or 2 min, and **Send**. Once the TV reports it shown: "Shown on Salon".

## Listen along

Opened from Now (the button or the listening bar), with a back arrow; Back returns to Now. What it offers is read
again on opening and every 10 s while shown.

- One line: "Sintel · Pilot on Salon. Plug in earphones."
- **Source**: one radio per source (or per audio language of a multi-audio source), with its media kind as a chip.
  The link found on this phone is one row: "Found link · none yet" with **Find**, or "Found link · ready" with **Find
  new** and **Forget**; the link's address is never shown. Choosing another source while listening switches at once.
- **Listen** / **Stop** (a full-width button).
- **Earphone delay**: −50 ms, the value ("nudge +50 ms"), +50 ms; "kept on this phone".
- **Timing for this source**, folded; closed it reads "offset −1.25 s · speed 1.0427". Open:
  - **Line it up**: "Tap when you see a moment on the TV, then when you hear it on the phone, in either order."
    **Mark on TV** takes the TV's position (the sync loop's estimate), **Mark on phone** the player's, both read at
    the tap. Until both are there: "TV marked at 12:04.2, now tap when you hear it" / "Phone marked at 12:05.5, now
    tap when you see it on the TV"; a new tap of the same kind replaces that half. With both, the offset becomes
    `round(phone − speed · TV)`, applies at once and the marks clear. A mark while not listening: "Listen first,
    then mark."
  - **Offset**: the readout (`+1:23.5`, `−0:04.0`, to 0.1 s) with **Edit**, which shows the seconds field; under it
    two rows of three nudges, −30 s −5 s −0.5 s and +0.5 s +5 s +30 s, "Moves the phone at once while you listen"
    (when not listening they change the value Listen starts with).
  - **Speed**: a 2 × 2 grid, **Same speed** (1), **PAL vs film** (1.0427), **Film vs PAL** (0.9591), **Other** (the
    decimal field, 0.5–2). The choice shown is the preset within 0.00005 of the speed, else Other.
  - **Save timing** (this episode and source) and, for a series, **Apply to all episodes**.
  - The admin page's Listen along card has the same words, maths and choices.
- **Sync details**, folded: the monospace status line (TV and phone positions, drift, state, media kind, clock).
- Choosing another source, or the TV moving to another episode while not listening, puts that source's stored timing
  back in the controls and clears a pending mark.

## Buttons

- Choices side by side are equal-width buttons with their label centred on one line: never a label pushed against a
  button's edge. Every row is checked to fit a 360 dp wide phone (Timing for this source has a test for it).
