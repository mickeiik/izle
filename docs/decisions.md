# Decision log

Choices that the code, the specs and AGENTS.md do not explain on their own: what was decided and why, a few lines
each, newest last. The earlier, longer log is in git history: `git show e7a6f7f:docs/decisions.md`.

## Cleanup pass (2026-10-15)

The owner asked for fewer lines of code, tests and docs, with no change in behaviour. They chose to delete the
roadmap, `docs/verification/` and the long log (all still in git history).
- Tests were merged into tables, and tests that re-checked what another test covers were dropped. Contract 31 → 12,
  server 142 → 132, TV 171 → 129. The redaction, upstream-header, local-loading and senior-invariant tests stay.
- Server store: one `fromRow` mapper and one private `insert` helper replace the per-table mappers. `insert` builds
  SQL from the store's own field names, never from request input. Shipped migrations are untouched.
- TV DTOs declare only the fields the app reads. Decoding stays lenient because `ignoreUnknownKeys` is set.
- Left in place: `Theme.kt`'s colour scheme (it may be dead, but only a visual check could show that). Also two
  existing admin focus losses, after "Reload from disk" and after approving a pairing code.

## Second cleanup pass (2026-10-15)

Same goal as the first, same rule (no change in behaviour); 28 554 → 27 333 tracked text lines. Tests: contract 12,
server 132 → 129, TV 129 → 126, the dropped ones covered by another test through the function the app calls.
- Exports that only tests used are private now; tests use the limits the spec documents instead of importing them.
- `Theme.kt` keeps the four colours tv-material actually reads (primary, surface, onSurface, surfaceTint).
- Left in place: `core-ktx` and `kotlinx-coroutines-android` (dropping them would lower a resolved version), the
  saved-but-unread `device_id` in `DeviceStore` (changing it changes what the TV stores), `admin-files.ts` as a file
  (the spec names it), `.dockerignore` entries for untracked local files. Response builders and fixtures now put
  several properties on one line; one commit ("response shapes and options packed onto fewer lines") carries that
  choice and can be reverted alone.

## Remote management foundation (2026-10-16)

- Migration 5 holds the whole remote-management schema (tokens, events, viewings, ranges, marks, command results),
  although this slice uses only part of it, so that the history and command slices built in parallel do not each
  claim a migration number. Saved positions are imported as viewings in SQL inside the migration.
- Events are published to stream and long-poll consumers from `Store.afterCommit` hooks, so a subscriber never hears
  of a change that rolled back, and the one `append()` call sits inside the change's transaction.
- `lastEventId` falls back to SQLite's sequence when the log is empty, so a consumer behind a purge that emptied the
  log still sees `gap: true` instead of a clean "nothing new".
- The scope table in the middleware already lists the routes of the later slices (single home changes, history
  marks), and every unlisted non-`GET` admin route needs the owner token, so a new route is never open by accident.
- `pairing.pending` has the server as its actor: the TV has no device id before the code is collected.

## Remote management: viewing history (2026-10-16)

- A TV that has not opened its event stream since the server started counts as offline since then, so the lost
  sweep's "offline for 2 minutes" rule holds from the start. A TV that reports progress without a stream loses its
  viewing after 2 minutes (the app always keeps one open); the TV's own resume and cursor are untouched.
- The pause and stall events are transitions: a second `paused` report in a row (or a repeated stall) emits
  nothing, so a consumer sees one `playback.paused` per pause.
- Played ranges are stored as the TV reports them, a consecutive report extending the previous row, and merged
  when read; the watched time is a running total on the viewing. A lost viewing's `endedAt` is its last report,
  earlier than its `playback.ended` event.
- `TitleSummary.episodes` and `seasons` count over the item's playable episodes in the current catalog (so `seen`
  never exceeds `total`); an episode that left the catalog counts only once the item itself has. `rewatches` are
  the seen viewings of an episode beyond its first, within the TV asked for; a mark is not a viewing.
- `sort=title` and the items within a day use the catalog search's collation (`byTitle` in catalog.ts).
