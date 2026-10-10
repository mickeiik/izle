# Phase 5 verification — admin page

Run on 2026-10-10 in a browser against the example server (`npm run -w server dev -- --config
server/examples/resolver-example/izle.example.json`, see [phase 4](../phase4/README.md)) with the Android TV
emulator paired to it, so every change could be watched arriving on the TV. The flows were driven by hand in the
browser; the page screenshots below were captured afterwards with a headless Chromium (1180 px wide, light; the
phone one 390 px, dark), the TV ones with `adb exec-out screencap`.

| # | Screenshot | Flow | Result |
|---|---|---|---|
| 1 | [01-sign-in](01-sign-in.jpg) | open `/admin/`, sign in with the admin token | wrong token: "That token is not valid."; right token: the TV list. Sign out returns here |
| 2 | [02-tvs-and-pairing](02-tvs-and-pairing.jpg) | TVs | paired TVs with Online/Offline and home counts; codes waiting for approval with a countdown |
| 3 | [03-device](03-device.jpg) | a TV's page | now playing with Stop, home list (posters, what OK plays, progress), search and Add, settings, recently watched, Forget |
| 4 | [04-continue-from-picker](04-continue-from-picker.jpg) | Episodes… on *Proxy series* | watched / next / new / not allowed per episode, "Continue from here", "Play now" |
| 5 | [05-catalog](05-catalog.jpg) | Catalog | bundle facts, resolver module hash and adapters, Reload from disk, all shows |
| 6 | [06-diagnostics](06-diagnostics.jpg) | a show → Test sources | per source: failed (the adapter found nothing) or OK with delivery, host, header names, languages, expiry, probe |
| 7 | [07-phone-dark](07-phone-dark.jpg) | the TV page on a phone, dark scheme | no horizontal scrolling; buttons wrap under each show |
| 8 | [08-tv-continue-from-episode-3](08-tv-continue-from-episode-3.jpg) | "Continue from here" on episode 3 | the TV tile changed to "Bölüm 3" live (menu language set to Türkçe from the page) |
| 9 | [09-tv-after-repairing](09-tv-after-repairing.jpg) | Forget this TV → approve the new code as "Living room" → add four shows | TV showed a new code within a second, then "Nothing here yet", then the four tiles |

Checked along the way (TV reactions on the emulator):

- **Catalog → Reload from disk** after adding a series to the bundle: new build id shown, the toast says every TV
  refreshes; the series appeared in the search.
- **Add** (search "series" → Add), **move up** ×6 and **remove**: saved at once; the TV's home screen followed the
  order when it returned home.
- **Stop** while a show played: the TV went to its home screen; now playing turned into "Last played".
- **Play** on a home entry: the TV started that show at once (`command queued` → `resolved` in the server log).
- **Settings:** menu language Türkçe and subtitles English → the TV switched its UI language and showed English
  subtitles on the next playback.
- **Pairing:** Approve without a name is refused ("Give the TV a name first.", focus moves to the name field); with
  a name the TV went to its home screen and showed as Online.
- **Diagnostics** on every episode of *Proxy series* (signed URL: probe HTTP 200; inline playlist: no network
  probe needed; MP4: HTTP 206) and on *Fallback demo* (first source empty, second OK).
- No script errors in the browser console; only failed requests while the server was being restarted and the
  401 of the deliberate wrong-token sign-in.

Automated (`npm test -w server`): helper functions of the page (`lib.js`), and that the page is served from an
allow-list with the CSP header, without inline code, and that other paths under `/admin/` answer 404.
