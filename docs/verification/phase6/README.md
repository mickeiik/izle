# Phase 6 verification — deployment and releases

Run on 2026-10-10. Everything below used local machines and containers only; nothing was published.

| Check | How | Result |
|---|---|---|
| Server package | `npm run pack:server` | `dist/izle-server-0.1.0.tgz`, 27 files, 442 KiB; identical bytes on a rebuild on the same machine |
| Installed package | `npm run smoke:server` on Node 26, and in `node:22.13.0-slim` / `node:24-slim` containers | every check passes (version, validation, admin token, admin page, pairing, home, posters, resolve, SIGHUP, SIGTERM, log without tokens) |
| Node version guard | the installed package on `node:20-slim` | "izle-server needs Node.js 22.13 or newer; this is v20.20.2", exit 1 |
| Docker image | `docker build`, then run with the default config and with a mounted catalog + config | healthy, `docker exec … admin-token`, `docker kill -s HUP` reloads, `docker stop` exits 0 |
| systemd unit | `systemd-analyze verify`, `systemd-analyze security --offline=true` | no warnings; exposure 1.4 "OK" |
| Syscall filter | installed package in a user-level transient unit with the unit's `SystemCallFilter`, `RestrictAddressFamilies`, `NoNewPrivileges`, … | serves, pairs, writes SQLite, reloads, stops cleanly |
| Caddyfile | `caddy validate` (as shipped, and with the admin block enabled), `caddy fmt` | valid, already formatted |
| Through Caddy 2.11 | containers: Caddy → izle, and Caddy → header echo | HSTS + CSP headers; forged `X-Forwarded-For` replaced by the real client; pairing long-poll answered 2.01 s after approval at 2 s; SSE `state` event 8 ms after a home change |
| Workflows | `actionlint` (with shellcheck) | clean |
| Android | `./gradlew :app:assembleDebug :app:testDebugUnitTest :app:assembleRelease` with a throwaway keystore, and without one | 50 JVM tests pass; signed `app-release.apk` (versionCode 100, not debuggable); unsigned fallback without a key |
| Release APK on the emulator | install the signed release APK, type the server address, approve the code, set four shows, OK | [home](01-release-apk-home.jpg) from the packaged server; [Caminandes 1](02-release-apk-playing.jpg) plays over HTTPS (system CAs still trusted next to the bundled ISRG roots) |
| Secret scan | gitleaks over the history and the working tree | one hit, the redaction tests' made-up token; marked as allowed |
| Release workflow | `gh workflow run release.yml` (dry run) on GitHub | server package, debug APK, checksums and notes built; publishing skipped, no release created |
| Server tests on Node 22 | `node:22-slim` (22.23.3) container | 3 resolver tests were cancelled (unref'd `AbortSignal.timeout` deadline); 77/77 after the fix |
