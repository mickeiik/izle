# Design pass verification — admin page

Run on 2026-10-14 in a headless Chromium 153 (a locally installed Playwright, not a project dependency) against the
example server on port 8788 (a copy of `server/examples/resolver-example/izle.example.json`, with the upstream on
port 8798 serving real media from `make-media.sh`). A fake TV, a script on the TV API, paired as "Living room",
kept its event stream open, played *Proxy series* episode 2 with a progress report every 10 s, acknowledged
commands, and reported one problem; "Kitchen" was approved but never collected its token. The catalog went
through two more builds (a new season and a film, then a show and an episode removed with "Reload from disk") so
the build history has something to show. Screenshots are 1280 px wide, light, unless they say phone (390 px,
dark).

| # | Screenshot | What it shows |
|---|---|---|
| 1 | [01-sign-in](01-sign-in.jpg) | sign-in after a wrong token: "That token is not valid." under the field, the focus back in it |
| 2 | [02-tvs-and-pairing](02-tvs-and-pairing.jpg) | a code waiting for approval (Approve is the card's one primary button), an approved code waiting for its TV (Approve inert), a TV online with "1 problem in 24 h", one waiting; rows with chevrons |
| 3 | [03-tv-page-top](03-tv-page-top.jpg) | a TV's page: name, status chip, the sticky section bar (current section marked), now playing with its state as a chip and Stop with the remote control |
| 4 | [04-home-screen-search](04-home-screen-search.jpg) | "Home screen" via the section bar: ▲ inert on the first row, ▼ on the last; "Add shows" with "pro" typed: the result count, "Add" as a secondary button, "On Home" |
| 5 | [05-settings](05-settings.jpg) | "Settings" via the section bar, the card under the bar |
| 6 | [06-catalog-builds](06-catalog-builds.jpg) | the catalog: bundle facts with the resolver's full hash, a warning, three builds and what the newest changed (full build id), every show with its playable count |
| 7 | [07-show-with-test](07-show-with-test.jpg) | a series: the show in its own card, the episodes in another; "Test sources" run on episode 1 |
| 8 | [08-phone-dark-tv-page](08-phone-dark-tv-page.jpg) | the whole TV page on a phone, dark: one-row header, the section bar scrolling sideways, buttons wrapping under each show, the history table scrolling inside its card |
| 9 | [09-phone-dark-tvs](09-phone-dark-tvs.jpg) | the TV list on a phone, dark |
| 10 | [10-phone-dark-film](10-phone-dark-film.jpg) | a film on a phone, dark: its sources under "Sources", no "Film" heading |
| 11 | [11-server-stopped-stale-note](11-server-stopped-stale-note.jpg) | the server stopped while the TV page was open: "Not updated since 19:27:57. The server cannot be reached. Retrying…" in the sticky bar, the content kept |
| 12 | [12-server-stopped-retry](12-server-stopped-retry.jpg) | then the Catalog tab: each region says it could not load, with Retry, instead of "Loading…" |
| 13 | [13-phone-dark-server-stopped](13-phone-dark-server-stopped.jpg) | the same on a TV's page, phone, dark |

Checked with scripts driving the page (keyboard input through Playwright's keyboard, not by focusing elements from
script, except to start a pass):

- **Keyboard only, across the polls.** Tab to "Move Fallback demo up", Enter twice: the row moves up twice and the
  focus stays on its ▲, which is then inert (`aria-disabled`) and sends nothing on Enter; Tab to its ▼, Enter: it
  moves down, the focus stays. 17 s later (three 5 s polls and a 15 s one) the focus is still there; on the remote's
  Pause it survives a 5 s poll, and a half-typed message survives one. ✕ on "Proxy demo" hands the focus to the ✕
  of the row that took its place. Typing "demo" in "Add shows" searches (`6 shows match “demo”.`); Add from the
  keyboard puts the show back on Home and the focus on the next show's Add. "Continue from here" in the episode
  picker closes it and puts the focus on its "Episodes…" toggle. On the TV list, a focused row survives the 3 s
  poll. A double click on Play sends one command.
- **Leaving a page mid-load.** With the TV's first answer held back 2.5 s, going to Catalog 0.3 s after opening the
  TV page: no request for that TV in the next 20 s, and the page stays on Catalog. An unknown TV left before its 404
  arrived: no redirect and no toast afterwards (staying on it still goes back to the TV list with a toast).
- **The server unreachable.** First loads of every view (refused connections): an error with Retry and no
  "Loading…"; with the server back, Retry loads the view and the focus stays in it (the TV page: its first
  heading). Polls failing on an open TV page: the "Not updated since" note within 6 s, gone within 6 s of the
  server answering again. Screenshots 11–13 were taken with the server process actually stopped.
- **Section bar.** "Settings" scrolls its card just under the bar (124 px from the top, the bar ends at 109 px),
  moves the focus to its heading, leaves the hash alone and marks itself current; at the bottom of the page
  "Problems" is current.
- **Search.** "Add shows" is empty with a hint until something is typed; clearing the box brings the hint back;
  "Show all" lists all shows (`All 7 shows.`) and puts the focus in the search box. Every per-row button has a name
  of its own; progress bars are progressbars with a label and a value text.
- **Listen along** (desktop Chromium, through hls.js): English and then Turkish of the TV's source, each in sync
  within 30 ms after 9 s (`TV 0:19.9 · phone 0:19.9 · drift −14 ms · synced · hls.js`); Stop ends it; leaving the
  page while listening stops the audio and nothing of the TV's page is fetched afterwards.
- **Every view at 1280 and 390 px, light and dark** (sign-in, TVs, a TV, catalog, a series, a film): no
  page-level horizontal scroll, the header 56 px high on a phone, and no console message except the 401 of the
  deliberately wrong sign-in and the refused requests while the server was stopped (no CSP violation).
- **Contrast**, from the tokens in `style.css`: every text pair at least 4.5:1 in both themes (lowest: danger on
  danger-bg, 5.4:1), `--line-strong` and `--focus` at least 3:1 against `--surface` and `--bg`.

Automated (`npm test -w server`): the page's pure helpers, the served files driven by `ADMIN_FILES` (types, CSP,
everything else a 404), no `innerHTML` or inline style writes in any module, and every module import resolving to
an allow-listed file reached from `app.js`.
