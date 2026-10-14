# TV design pass verification — the look, the banner in Home's top band, countdown bars, one poster panel

Run on 2026-10-14 on the `izle_tv` AVD (Android TV, API 36, x86_64, 1920×1080 at 320 dpi, so the app's 960×540 dp
canvas) started headless with `-no-window -no-audio -gpu swiftshader_indirect -no-snapshot -cores 2 -memory 2048`,
debug APK from `./gradlew :app:assembleDebug :app:testDebugUnitTest` (101 JVM tests, all green). Keys were sent
with `adb shell input keyevent`, the owner's side driven through the admin API (`PUT …/home`, `POST …/commands`
with `message`, `PATCH …/devices/:id` for `autoplayOnStart`, `uiLanguage` and `subtitlesLanguage`,
`POST /api/v1/admin/catalog/reload`), screenshots taken with `adb exec-out screencap` and scaled to 1280×720 JPEG.

The server was this branch's, on `http://10.0.2.2:8787` as the emulator sees it, with a scratch copy of the sample
catalog kept outside the repository: the six sample shows plus a film with a 55-character title and no poster, and
*Broken film* (no poster, its only source on a closed port of the TV itself, so nothing can play it). Later builds
of the copy (new build ids, then a reload) added episodes to *Caminandes* for the new-episodes chip. The 200-character
message is the longest the server accepts:

> Dinner is ready! Please come to the kitchen when you have finished watching this episode, the soup is hot and
> your grandchildren have arrived to see you. They brought a cake and fresh flowers for you.

## Home

| # | Screenshot | Step | Result |
|---|---|---|---|
| 1 | [01-home-one-row](01-home-one-row.jpg) | four shows on Home | one row inside the margins, no fade (nothing below); "Episode 1" on a light chip that reads on the dark poster; the hint says only "OK: Play" |
| 2 | [02-home-two-rows](02-home-two-rows.jpg) | eight shows | the second row peeks in under the titles and fades out at the bottom edge; the chips: light "Episode 1", warm "Continue" with progress, mint "New" |
| 3 | [03-home-second-row-focused](03-home-second-row-focused.jpg) | ↓, →, → | the second row came up to the top: the focused poster, its border and its two-line title fully in view, the first row gone completely (before: [before-02](before-02-second-row-focused.jpg), the poster and title cut at the bottom, the first row's titles cut at the top); the poster-less film shows its title, split at a syllable |
| 4 | [04-home-banner-short](04-home-banner-short.jpg) | `message` "Dinner is ready!" | the banner in the top band left of the clock, 30 sp; the tiles moved down to make room, the hint gave way; the focused tile's grown border clear of it |
| 5 | [05-home-banner-200](05-home-banner-200.jpg) | the 200-character message, focus on the second row | too long for three lines beside the clock: the band's full width under the clock, all 200 characters in three lines; the focused poster still inside the safe area, its border whole (before: [before-01](before-01-message-on-home.jpg), the old overlay over the clock, the first row and the focused border, the message cut at "a ca…") |
| 6 | [06-home-banner-expired](06-home-banner-expired.jpg) | 12 s later | the message gone by itself; the grid back where it was, the same tile focused, the hint back |
| 7 | [07-home-new-episodes](07-home-new-episodes.jpg) | two episodes added to *Caminandes*, catalog reloaded | "2 new" on one line, small, dark and regular weight at the top right; the bottom chip still says what OK plays ("Episode 1") |
| 8 | [08-home-continue](08-home-continue.jpg) | about 40 s of episode 1, Back | "Continue · Episode 1" on two tight lines with the progress bar under it, about a quarter of the poster (a third before); "2 new" gone (an episode was played) |

## Player

| # | Screenshot | Step | Result |
|---|---|---|---|
| 9 | [09-player-paused-info](09-player-paused-info.jpg) | OK during episode 1 | the information on a shade that is solid behind the text (it faded through the title before) |
| 10 | [10-banner-over-video](10-banner-over-video.jpg) | the 200-character message while playing | across the top inside the margins, all of it in three lines, the video playing on |
| 11 | [11-up-next](11-up-next.jpg) | → ×4 to the end of episode 1 | the shared panel: "Up next", "Episode 2", its title, "Starts in 9 s" over a bar that ran down one step, **Play now** focused (white fill and border), **Home** dark with a grey outline |
| 14 | [14-the-end](14-the-end.jpg) | the last episode (8) to its end | "The end" with the poster and the show's title, the poster where Up next has it; no buttons; Home 8 s later |
| 15 | [15-cannot-play](15-cannot-play.jpg) | OK on *Broken film* | "Can't play right now", "Home in 28 s" over its bar, **Try again** focused; no poster, so the title in its place |
| 16 | [16-cannot-play-home-focused](16-cannot-play-home-focused.jpg) | → | **Home** focused, **Try again** dark: one white button at a time (left alone in an earlier run of the screen, it went Home by itself at 0) |
| 29 | [29-subtitles-above-the-information](29-subtitles-above-the-information.jpg) | `subtitlesLanguage: en`, *Sintel* at 2:10, OK | the subtitle just above the information, not under it |

## Hidden menu

| # | Screenshot | Step | Result |
|---|---|---|---|
| 12 | [12-menu-root](12-menu-root.jpg) | Menu on *Caminandes* | the focused row with the white border on a lighter fill (the stock lavender fill before), its right edge at the safe margin (13 dp from the screen edge before); the tiles behind stay where they were |
| 13 | [13-menu-episodes](13-menu-episodes.jpg) | OK on Episodes | ✓ for watched in grey (it was the mint of "New"), ▶ in the warm accent, the focused row bordered |
| 25 | [25-menu-settings](25-menu-settings.jpg) | Settings | the same rows and focus |

## Autoplay on start

| # | Screenshot | Step | Result |
|---|---|---|---|
| 17 | [17-autoplay-countdown](17-autoplay-countdown.jpg) | `autoplayOnStart: true`, app restarted | the shared panel, the poster at Up next's spot, "Starts in 8 s" over its bar, **Play now** focused |
| 18 | [18-banner-over-autoplay](18-banner-over-autoplay.jpg) | restarted, a message during the countdown | the banner over the (opaque) countdown, across the top |
| 19 | [19-banner-back-in-the-band](19-banner-back-in-the-band.jpg) | Back | the countdown cancelled; the same message now in Home's top band, the focus on the show |

## Offline, Turkish, first run

| # | Screenshot | Step | Result |
|---|---|---|---|
| 20 | [20-offline](20-offline.jpg) | server stopped | "No connection": solid red, dark text, in the top band |
| 21 | [21-offline-ok](21-offline-ok.jpg) | OK | the "No connection · Trying again…" message, 5 s |
| 22 | [22-home-turkish](22-home-turkish.jpg) | `uiLanguage: tr` while Home showed | "Bölüm 1", "Devam et", "Yeni", "OK: Oynat"; the clock switched to "ÖS" at once (it kept "PM" until the next minute before) |
| 23 | [23-home-banner-turkish](23-home-banner-turkish.jpg) | a Turkish message | in the band beside the clock, at full size |
| 24 | [24-cannot-play-turkish](24-cannot-play-turkish.jpg) | OK on *Broken film* | "28 sn sonra ana ekran" (the draft Turkish to check), "Tekrar dene" focused |
| 26 | [26-pairing](26-pairing.jpg) | Settings → Pair again | unchanged proportions, the code box with the panels' rounding, the hint at the safe margin |
| 27 | [27-server-address](27-server-address.jpg) | Back | the field focused: white border; the content inside the margins |
| 28 | [28-server-address-connect-focused](28-server-address-connect-focused.jpg) | ↓ | **Connect** in the shared button style, its 10 % growth still inside the left margin; the field's border grey |

## Checked against the senior rules

Every screen above: no text below 24 sp (the smallest are the chips, the hint and the menu's second lines, all
24 sp); dark text on the light, mint, warm and red chips and white text on the dark ones; exactly one element with the
white border (or the white fill of a focused button); nothing that matters outside 48 dp left and right and 27 dp top
and bottom, the focused poster's 10 % growth included. The faded peek of the next row and a long message pushing the
titles down are the only things drawn in the bottom margin.

## Not verified here

- A real remote and a real TV (only the emulator), and how the fade and the light chips look on a real panel.
- The banner over the hidden menu (the same overlay path as over the autoplay countdown, not captured).
- A message arriving while the TV is offline (the chip and the banner side by side in the band).
