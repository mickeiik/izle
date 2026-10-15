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
