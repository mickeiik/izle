# Self-hosting izle

izle has two parts: **izle-server**, on a machine that is always on (a home server, NAS, mini PC, Raspberry Pi 4/5
or a small VPS), and the **Android TV app**, which talks only to that server. This guide runs the server as a
systemd service, optionally behind Caddy for HTTPS, and installs the app on a TV. Commands assume a
Debian/Ubuntu-like Linux with systemd; `izle-server-X.Y.Z.tgz` is the server package and
`PKG=/opt/izle/lib/node_modules/@izle/server` is where it ends up.

## 1. Choose a setup

| | LAN only | HTTPS with a domain |
|---|---|---|
| TVs | at home, on the same network | anywhere (a parent's house, a holiday flat) |
| TV address | `http://192.168.1.10:8787` | `https://izle.example.org` |
| Server listens on | `0.0.0.0:8787` | `127.0.0.1:8787`, Caddy in front on 443 |
| Admin page | from the LAN | from anywhere (or LAN/VPN only, see §6) |
| Extra parts | none | a domain name, ports 80 and 443 forwarded to the server, Caddy |

Plain HTTP is acceptable on a LAN. Never expose port 8787 to the internet: without TLS the admin token and the TVs'
device tokens travel in clear text.

## 2. Install the server

**Node.js 22.13 or newer** (Node 24 LTS is a good choice), installed system-wide (`/usr/bin/node` or
`/usr/local/bin/node`): the service cannot see a Node that a version manager (nvm, mise, fnm) installed in a home
directory. Use your distribution's package if `node --version` is recent enough, else the
[nodejs.org](https://nodejs.org/en/download) binaries or the NodeSource packages.

**The package:** download `izle-server-X.Y.Z.tgz` and `SHA256SUMS` from the GitHub release and check them with
`sha256sum --check --ignore-missing SHA256SUMS` (in a checkout, `npm ci && npm run pack:server` writes the same file
to `dist/`). The server and its libraries are bundled in one file, so installing downloads nothing else and needs no
build tools. The package holds the server, the admin page, the sample catalog and the example files used below
(`deploy/`).

```bash
sudo useradd --system --user-group --home-dir /var/lib/izle --shell /usr/sbin/nologin izle
sudo npm install --global --prefix /opt/izle ./izle-server-X.Y.Z.tgz
/opt/izle/bin/izle-server --version
```

## 3. Configure

```bash
PKG=/opt/izle/lib/node_modules/@izle/server
sudo install -d -m 0750 -o root -g izle /etc/izle
sudo install -m 0640 -o root -g izle $PKG/deploy/izle.example.json /etc/izle/izle.json
sudoedit /etc/izle/izle.json
```

Only the `izle` group can read the file, because a resolver module's `config` may contain keys. The example
([`izle.example.json`](izle.example.json)) is set up for HTTPS behind Caddy on the same machine: `listen` on
`127.0.0.1:8787` (`"host": "0.0.0.0"` for the LAN-only setup), `publicUrl` (the address izle is reached at, base of
the admin sign-in link, §5), `trustedProxies` `["127.0.0.1", "::1"]` (`[]` when nothing sits in front), `dataDir`
`/var/lib/izle` (database, admin token, the resolver module's directory, the TV app's APK), no `catalog.dir` (the
package's sample catalog), `resolver: null`, `defaults` `en` for the menu and audio language of TVs without their own
setting (`tr` for Turkish), and `appUpdates` fetching the TV app from the project's GitHub releases (§ 8; `"source":
"manual"` to upload APKs yourself instead). Every key:
[server-api-v1.md § Configuration](../spec/server-api-v1.md#configuration).

### Your own catalog

A catalog bundle is a directory (`bundle.json`, `items.json`, `assets/`; see
[catalog-bundle-v1.md](../spec/catalog-bundle-v1.md)). Keep it outside the package, under `/srv/izle`, readable by
everyone; the server only reads it. The recommended layout keeps every build in its own directory (any name; the
bundle's `buildId` is convenient) and a relative symlink, `current`, on the active one (relative, so it also resolves
inside a container, §9):

```
/srv/izle/catalog/
  builds/20261012-1a2b3c4d5e6f/      bundle.json, items.json, assets/
  builds/20261014-7a8b9c0d1e2f/
  current -> builds/20261014-7a8b9c0d1e2f
```

```bash
B=20261014-7a8b9c0d1e2f
sudo install -d -m 0755 /srv/izle /srv/izle/catalog /srv/izle/catalog/builds
sudo cp -r ./my-catalog /srv/izle/catalog/builds/$B
/opt/izle/bin/izle-server validate-catalog /srv/izle/catalog/builds/$B
sudo ln -s builds/$B /srv/izle/catalog/current
```

Then add `"catalog": { "dir": "/srv/izle/catalog/current" }` to the config.

**To publish a new build**, put it next to the others, validate it, swap the link and reload (or press **Reload
from disk** on the admin page's Catalog tab instead of the last line):

```bash
B=20261015-3c4d5e6f7a8b
sudo cp -r ./my-catalog /srv/izle/catalog/builds/$B
/opt/izle/bin/izle-server validate-catalog /srv/izle/catalog/builds/$B
sudo ln -sfn builds/$B /srv/izle/catalog/current.new
sudo mv -T /srv/izle/catalog/current.new /srv/izle/catalog/current
sudo systemctl reload izle
```

`mv -T` replaces the link in one step, so the server never sees a half-copied build. The server keeps `catalog.dir`
as configured (it does not resolve the link), so each reload reads whichever build `current` points at.

- **An invalid bundle is refused** on reload and the previous build stays active. `systemctl reload` does not tell
  you: check `journalctl -u izle -n 5`, or use the admin page's button, which lists the problems. Then point
  `current` back at the previous build: the server reads posters through the link, and a restart would load
  whatever it points at.
- **To roll back**, point `current` at an older build and reload. **Old builds** can be deleted once you no longer
  want to go back to them; the server reads only the one behind `current`.

Progress and home lists survive new builds because catalog ids are durable. Coming from a single directory at
`/srv/izle/catalog`: move it to `/srv/izle/catalog/builds/<buildId>`, create the link, change `catalog.dir` and
restart. A single directory still works (copy the new build next to it, validate it, swap the directories, reload),
but leaves no simple way back.

### A resolver module

Catalogs whose streams are resolved at play time need the owner's resolver module
([resolver-module-v1.md](../spec/resolver-module-v1.md), [example](../../server/examples/resolver-example/README.md)):
plain JavaScript (an ES module; the package does not run TypeScript) loaded from a local path, never downloaded. Put
it in `/srv/izle/resolver/`, owned by root, and configure it:

```json
"resolver": { "module": "/srv/izle/resolver/index.js", "config": { } }
```

The module may write only to its own directory, `/var/lib/izle/resolver` (`ctx.dataDir`). Check it, and that it
provides every adapter the catalog needs:

```bash
sudo -u izle /opt/izle/bin/izle-server check-resolver --config /etc/izle/izle.json
```

The server loads the module once, at start, so **a new module file needs `sudo systemctl restart izle`** (a reload
re-reads the catalog only). A reload refuses a catalog build that needs an adapter the running module does not
provide, so install the new module first, check it, and restart.

### Letting a job on the host publish builds

A script or timer on the same machine that produces catalog builds can publish them itself, without sudo: give it
its own system user (here `izle-publish`) that owns `/srv/izle/catalog` and a copy of the admin token, and let it ask
the server to reload through the admin API. Set this up once the service runs (§4) and has created its admin token
(§5):

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/izle-publish --shell /usr/sbin/nologin izle-publish
sudo chown -R izle-publish:izle-publish /srv/izle/catalog
sudo install -m 0600 -o izle-publish -g izle-publish /var/lib/izle/admin.token /var/lib/izle-publish/admin.token
```

- **Permissions:** with the default umask of 022 the job creates directories with mode 0755 and files with 0644, so
  the service can read every build; the service itself stays read-only on `/srv` (`ProtectSystem=strict`). The job
  never writes `/var/lib/izle` and never touches the config or the resolver module.
- **The token copy** is readable by `izle-publish` only. After `izle-server admin-token --rotate` (§5), copy it again
  with the last command above.
- **Publishing** is the sequence from [Your own catalog](#your-own-catalog), run as `izle-publish` without `sudo`,
  with `POST /api/v1/admin/catalog/reload` and `Authorization: Bearer <token>` in place of `systemctl reload`.
  `200`: the new build is active. `422`: the server refused it and kept the previous build (for example, the bundle
  needs an adapter the resolver module does not provide), so point `current` back at the previous build.
- **Allow a generous timeout:** a reload re-hashes every poster, which can take a minute or more on a small machine
  with a large catalog. After a timeout the server may still finish; `GET /api/v1/admin/catalog` shows its `buildId`.
- **Fail on `401`, never retry:** wrong tokens count towards the admin sign-in throttle (§5), which also blocks
  `izle-server pair` on the same machine. A `429` means the lockout is on.

A publish step along those lines (`publish <buildId>`, once the build is in `builds/<buildId>/`):

```sh
#!/bin/sh
# Activates /srv/izle/catalog/builds/<buildId>. Runs as izle-publish.
set -eu
home=/var/lib/izle-publish
cd /srv/izle/catalog
/opt/izle/bin/izle-server validate-catalog "builds/$1"
previous=$(readlink current)
ln -sfn "builds/$1" current.new && mv -T current.new current
# The token goes to curl on stdin, never on a command line that other users can see.
status=$(printf 'Authorization: Bearer %s\n' "$(cat "$home/admin.token")" |
  curl -sS -H @- -X POST --max-time 600 -o "$home/reload.json" -w '%{http_code}' \
    http://127.0.0.1:8787/api/v1/admin/catalog/reload) || true
if [ "$status" != 200 ]; then
  ln -sfn "$previous" current.new && mv -T current.new current
  echo "reload answered $status; back on $previous (the answer is in $home/reload.json)" >&2
  exit 1
fi
```

## 4. Run it with systemd

```bash
sudo install -m 0644 $PKG/deploy/izle.service /etc/systemd/system/izle.service
sudo systemctl daemon-reload
sudo systemctl enable --now izle
systemctl status izle
curl -s http://127.0.0.1:8787/healthz          # {"ok":true}
```

The unit ([`izle.service`](izle.service)) runs the server as `izle` in a tight sandbox (`systemd-analyze security
izle` rates it around 1.4, "OK"): the whole file system is read-only except `/var/lib/izle`, home directories are
hidden (so keep the catalog and resolver module outside `/home`), and there are no capabilities and no privileged
system calls. If `node` is not on systemd's default `PATH`, give its full path with `sudo systemctl edit --full izle`:
`ExecStart=/usr/local/bin/node /opt/izle/bin/izle-server --config /etc/izle/izle.json`.

- **Logs:** one JSON object per line, never with stream URLs, upstream headers or tokens: `journalctl -u izle -f`,
  or only problems: `journalctl -u izle -o cat | jq -c 'select(.level != "info")'`. On Node 22 a single "SQLite is
  an experimental feature" warning at start is expected.
- **`sudo systemctl reload izle`** (SIGHUP) re-reads the catalog only; **`sudo systemctl restart izle`** after a
  config change or a new resolver module. TVs reconnect on their own.

## 5. The admin token and the admin page

The first start creates a random admin token in `/var/lib/izle/admin.token` (mode 0600). Print it with:

```bash
sudo -u izle /opt/izle/bin/izle-server admin-token --config /etc/izle/izle.json
```

Open `http://<server>:8787/admin/` (or `https://izle.example.org/admin/`) and sign in with it. Treat it like a
password: it controls every TV. The page keeps it in the browser's local storage, so use **Sign out** on shared
computers.

**From a phone**, add `--link`: it prints a sign-in link and the same link as a QR code for the phone's camera. The
link uses `publicUrl` from the config (or `--base <url>`); the token sits in the URL fragment, which browsers never
send anywhere, and the page removes it from the address bar once signed in. The link is as secret as the token. The
QR code is drawn for a dark terminal; on a light one it appears inverted, which phone cameras usually read anyway.

**A passphrase instead of the random token:** any token of 24 characters or more without spaces is accepted, so a
memorable one such as `correct-horse-battery-staple-9` works for typing on a phone. Put it in the token file and
restart:

```bash
echo 'correct-horse-battery-staple-9' | sudo -u izle tee /var/lib/izle/admin.token > /dev/null
sudo systemctl restart izle
```

Keep the token in that file. **Never put `IZLE_ADMIN_TOKEN` in the unit with `Environment=`** (in the unit or in a
`systemctl edit` drop-in): systemd shows a unit's `Environment=` to every local user (`systemctl show izle`), and
drop-in files are world-readable. If the variable is needed anyway, keep it in a file only root can read and name
that file with `EnvironmentFile=` (systemd then shows only its path), and remember that the shell commands need the
variable as well:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/izle/admin.env
echo 'IZLE_ADMIN_TOKEN=correct-horse-battery-staple-9' | sudo tee /etc/izle/admin.env > /dev/null
sudo systemctl edit izle    # add:  [Service]  EnvironmentFile=/etc/izle/admin.env
```

Guessing is throttled: after 10 wrong tokens from one address within 10 minutes, the server refuses every admin
request from that address, even with the right token, until the 10 minutes are over. Each wrong token is logged as
a warning ("admin auth failed") with the address it came from.

To replace the token with a new random one (every signed-in browser has to sign in again):

```bash
sudo -u izle /opt/izle/bin/izle-server admin-token --config /etc/izle/izle.json --rotate
sudo systemctl restart izle
```

`--rotate` replaces the token file. While `IZLE_ADMIN_TOKEN` is set the variable is the token in use and the file is
ignored, so `--rotate` refuses to run; change or remove the variable instead. (`sudo -u izle` drops the variable
from the shell, so a rotation can still write a file the server then ignores: at startup the server logs the
warning "IZLE_ADMIN_TOKEN overrides the admin token file" whenever the variable shadows a token file.)

### Access tokens for apps and agents

The admin token is the owner's and stays out of scripts. An app, a home-automation hook or an AI agent gets its
own **access token** with one scope: `read` (sees the TVs, the catalog, the history and the events), `control`
(read, plus commands: play, pause, a message), or `manage` (control, plus home screens, settings and history
marks). Pairing, deleting a TV or its history, diagnostics, Listen along and the tokens themselves stay with the
owner token. Create one on the admin page under **Access**, or from the shell:

```bash
sudo -u izle /opt/izle/bin/izle-server token create "Home assistant" --scope control --config /etc/izle/izle.json
```

It prints the secret once (`izat_…`); the server keeps only its hash. `token list` shows the tokens with when each
was last used, `token revoke <id>` cuts one off at once. A revoked or wrong token counts like a wrong admin token
for the throttle above, so stop an app before revoking its token, or it locks its address out for 10 minutes.

What a token can call is in the [server API](../spec/server-api-v1.md#remote-management): `GET /api/v1/admin/status`
(every TV in one call), the event stream and long-poll, the viewing history, and the commands.

## 6. HTTPS with Caddy

Prerequisites: a domain or subdomain whose DNS A/AAAA record points at your public address, and ports 80 and 443
forwarded to the server (Caddy obtains and renews the certificate itself through Let's Encrypt).

1. Install Caddy from your distribution or [caddyserver.com](https://caddyserver.com/docs/install); it runs as its
   own systemd service.
2. Copy the example and put your domain in it:
   ```bash
   sudo cp $PKG/deploy/Caddyfile /etc/caddy/Caddyfile
   sudoedit /etc/caddy/Caddyfile        # replace izle.example.org
   sudo systemctl reload caddy
   ```
3. In `/etc/izle/izle.json` keep `"host": "127.0.0.1"` and `trustedProxies` `["127.0.0.1", "::1"]`, set
   `publicUrl`, and restart izle.
4. Check from outside: `curl https://izle.example.org/healthz`.

What the [Caddyfile](Caddyfile) does and why:

- `flush_interval -1` passes every response through as it arrives: the TVs' live updates (server-sent events on
  `/api/v1/tv/events`), the 25-second pairing long-poll and proxied video. Caddy has no response timeout by
  default, which is what these need.
- Caddy replaces any `X-Forwarded-For` a client sends with the client's real address; izle trusts it only from
  `trustedProxies`.
- `Strict-Transport-Security` keeps browsers on HTTPS for the admin page.
- No access log and no `encode`: request paths contain media-proxy session tokens and pairing codes, and
  compression would buffer the event stream.
- The commented `@admin_outside` block answers the admin page and admin API only from private addresses (your LAN,
  or a VPN such as WireGuard/Tailscale). TVs never use those routes.

Another reverse proxy works if it does the same: no response buffering for `/api/v1/tv/events` (nginx:
`proxy_buffering off;`), read timeouts above 60 s (the server sends an event-stream ping every 20 s), and the
client address in `X-Forwarded-For`.

Android 7.0 does not know Let's Encrypt's root certificates; the app carries them itself, so a TV on 7.0 works with
a Caddy certificate too.

## 7. Firewall

- **LAN only:** allow port 8787 from your LAN and nothing else, e.g. with ufw:
  `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.
- **With Caddy:** allow 80 and 443 (`sudo ufw allow 80,443/tcp`). Port 8787 needs no rule: the server listens on
  127.0.0.1 only.
- The server makes outgoing connections for resolver modules and the media proxy (to the upstream hosts your
  catalog uses), and, with `appUpdates.source` `github` (the default), once a day to `api.github.com` and
  `objects.githubusercontent.com` for the TV app's releases (§ 8). TVs fetch direct (non-proxied) streams themselves. "Listen along" (companion audio on your phone)
  runs in the admin page and gets its stream through the server's proxy, so the phone needs only the admin page.

## 8. Install the TV app

The release has two APKs:

- **`izle-tv-X.Y.Z.apk`**, signed with the project's release key (present when the release workflow has one). Use
  this one on a TV: every later release installs over it and keeps the pairing. Without a release key, build a signed
  APK yourself ([releasing.md](../releasing.md#android-release-signing)).
- **`izle-tv-X.Y.Z-debug.apk`**, for trying izle and for the emulator. It is signed with a throwaway key, so a later
  APK cannot be installed over it: uninstall it first, and the TV has to be paired again (as a new TV). Its server
  address field starts with the emulator's `http://10.0.2.2:8787`.

**With adb over the network** (any Android TV / Google TV):

1. On the TV: Settings → Device Preferences (or System) → About, select the build number seven times to unlock
   Developer options, then turn on **USB debugging**. On most TVs this also accepts connections over the network;
   newer Google TV devices use **Wireless debugging** with a pairing code instead.
2. From a computer with [platform-tools](https://developer.android.com/tools/releases/platform-tools):
   ```bash
   adb connect 192.168.1.20:5555          # the TV's address; accept the prompt on the TV
   # Android 11+ wireless debugging instead: adb pair <ip>:<pairing port>, then adb connect <ip>:<port>
   adb install -r izle-tv-X.Y.Z.apk
   ```
3. Turn debugging off again afterwards if you like. Updates use the same `adb install -r`.

**Without a computer:** install a file-transfer app such as *Send files to TV* on both the TV (Play Store) and your
phone, send the APK, open it on the TV with a file manager and allow that app to **install unknown apps** when
asked. A USB stick and any file manager work the same way.

**First start:** the app asks for the server address (`http://192.168.1.10:8787` or `https://izle.example.org`),
then shows a 6-digit pairing code and the admin page's address. On the admin page (**TVs**), approve the waiting
code (a name is optional; the TV is called "TV" otherwise and can be renamed later), then add shows to that TV's
home screen; the tiles appear on the TV right away. From the server's shell the same approval is
`sudo -u izle /opt/izle/bin/izle-server pair approve 483920 Living room --config /etc/izle/izle.json`
(`pair pending` lists the waiting codes; `--server <url>` when the server does not listen where the config says).
Put izle first in the TV launcher's favourites so it is the first thing on screen.

### Updating the TV app

The first install is the only one done at the TV. The server keeps one current APK and offers it to every paired TV:

- **Where the APK comes from.** With the default `"appUpdates": { "source": "github" }` the server checks the
  project's latest release once a day (and when you press **Check now** on the admin page's **TV app** tab),
  downloads `izle-tv-X.Y.Z.apk`, verifies it against the release's `SHA256SUMS` and stores it in `dataDir`. With
  `"source": "manual"` nothing is fetched: upload the release APK on the same tab (from a phone works). The server
  never installs or runs the file; a TV only installs an APK signed with the key of the app it runs, so a debug APK
  cannot update a release install.
- **Allow the app to install updates, once.** Right after the first install, on the TV: Settings → Apps → Security &
  restrictions (or Special app access) → **Install unknown apps** → izle → allow. On Android 7 it is the single
  **Unknown sources** switch instead. Without it a TV reports "needs Install now" and the system asks for the
  permission the first time.
- **Android 12 and newer** TVs install a newer APK by themselves, with no dialog, once they have sat idle on the home
  screen for three minutes (never during playback). Android closes the app to replace it and does not let it come
  back on its own, so the TV shows its launcher afterwards: the next time izle is opened (first in the favourites
  row) it runs the new version. The admin page shows each TV's installed version and when it changed.
- **Android 11 and older** (the Freebox Player Mini, for example) cannot install silently: Android always shows an
  Install/Cancel dialog. Nothing happens on its own. Press **Install now** on the admin page while someone is at the
  TV: the TV shows a large "New version, press OK" screen; OK opens the system dialog ("Do you want to update this
  app?"), where the viewer moves to **Update** (the dialog may start on Cancel) and presses OK. Back, or a minute
  without a press, returns to the home screen and the update waits for the next time. On Android 10 and 11 the TV
  then shows its launcher as above; Android 9 and older bring izle back by themselves.
- The TV reports the outcome as the command's result (installing, prompted, ignored because it was playing, or a
  failure code) and keeps the pairing, the home screen and the progress across updates.

## 9. Docker (alternative to systemd)

The repository's [`Dockerfile`](../../Dockerfile) builds an image from the same package (Node 24, runs as an
unprivileged user, data in a volume). Without further options it serves the sample catalog:

```bash
docker build -t izle-server .
docker run -d --name izle --restart unless-stopped -p 8787:8787 -v izle-data:/var/lib/izle izle-server
docker exec izle izle-server admin-token --config /etc/izle/izle.json
```

For your own catalog, mount it and a config file:

```bash
docker run -d --name izle --restart unless-stopped -p 8787:8787 \
  -v izle-data:/var/lib/izle \
  -v /srv/izle/catalog:/srv/izle/catalog:ro \
  -v /etc/izle/izle.json:/etc/izle/izle.json:ro \
  izle-server
```

with `"listen": { "host": "0.0.0.0", "port": 8787 }`, `"dataDir": "/var/lib/izle"` and
`"catalog": { "dir": "/srv/izle/catalog/current" }` in that file (the layout of §3; mount the whole
`/srv/izle/catalog` so the relative `current` link resolves). `docker kill -s HUP izle` reloads the catalog only; a
new resolver module (mounted the same way) needs `docker restart izle`. Behind a reverse proxy in another container,
publish no port (or bind it to `127.0.0.1:8787:8787`) and set `trustedProxies` to the Docker network's range, e.g.
`["172.16.0.0/12"]`. To update, rebuild the image from the new release's sources and recreate the container; the
volume keeps the data (including the TV app's APK, which the container fetches from GitHub unless the config says
`"appUpdates": { "source": "manual" }`; a container without outgoing network access needs that setting).

## 10. Updates and backups

**Back up** the database, the admin token (`/var/lib/izle/admin.token`), `/etc/izle` and `/srv/izle`. Copy the
database with `izle-server backup`, a consistent snapshot taken while the service keeps running (copying `izle.db`
by hand is not enough: recent changes sit in `izle.db-wal` next to it). The copy is a single file, readable by the
`izle` user only:

```bash
sudo -u izle mkdir -p /var/lib/izle/backups
sudo -u izle /opt/izle/bin/izle-server backup --config /etc/izle/izle.json /var/lib/izle/backups/izle-$(date +%F).db
```

**Daily, with systemd:** the package's [`izle-backup.service`](izle-backup.service) and
[`izle-backup.timer`](izle-backup.timer) write such a copy every day and delete copies older than 30 days. The copies
stay on the server's disk, so let your usual backup tool pick up `/var/lib/izle/backups` along with the rest.

```bash
sudo install -m 0644 $PKG/deploy/izle-backup.service $PKG/deploy/izle-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now izle-backup.timer
sudo systemctl start izle-backup && ls -l /var/lib/izle/backups      # a first copy right away
```

**With Docker:** `docker exec izle izle-server backup --force --config /etc/izle/izle.json /var/lib/izle/backup.db &&
docker cp izle:/var/lib/izle/backup.db ./izle-$(date +%F).db` (`--force` replaces an existing file).

**Restore** a copy with the service stopped, removing the write-ahead files of the database being replaced so they
are not applied to the restored one. TVs paired after the copy was taken have to pair again.

```bash
sudo systemctl stop izle
sudo rm -f /var/lib/izle/izle.db-wal /var/lib/izle/izle.db-shm
sudo install -m 0600 -o izle -g izle /var/lib/izle/backups/izle-2026-10-14.db /var/lib/izle/izle.db
sudo systemctl start izle
```

**Update the server** (a new catalog build needs only a reload, §3):

```bash
sudo -u izle /opt/izle/bin/izle-server backup --config /etc/izle/izle.json /var/lib/izle/backups/before-X.Y.Z.db
sudo npm install --global --prefix /opt/izle ./izle-server-X.Y.Z.tgz
sudo systemctl restart izle
journalctl -u izle -n 5 -o cat                  # "listening" with the new version
```

The database is migrated on start, and an older server refuses a database a newer one has migrated: to go back,
install the older package **and** restore the copy taken before the update (`before-X.Y.Z.db`). The admin page's
Catalog tab shows the running server version. Update the server before the TVs: a newer app may report fields an
older server rejects (the app then falls back, but the first report after each start is lost).

**Update the TVs** from the admin page's **TV app** tab (§ 8, "Updating the TV app"): the server fetches the
release's APK by itself (or you upload it), TVs on Android 12+ install it while idle, older TVs when you press
**Install now** and someone at the TV presses OK. The tab lists each TV's installed version.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `status=203/EXEC` in `systemctl status izle` | `node` is not on the service's `PATH` (installed in a home directory); see §4 |
| The service exits with `EACCES` | the catalog, resolver module or config is not readable by the `izle` user |
| "the catalog bundle is invalid" | run `izle-server validate-catalog <dir>` for the full report |
| A reload refuses a build for an adapter the new resolver module provides | the module is loaded at start only: `sudo systemctl restart izle` |
| The TV shows "No connection" behind a proxy | buffering or a short timeout on `/api/v1/tv/events`; `curl -N https://<domain>/api/v1/tv/events` should answer `401` at once, not hang |
| The TV's pairing screen says to wait, and the log shows `429` on `/api/v1/pair/start` | many pairing attempts from one address; behind a proxy, check `trustedProxies` |
| `429` on admin routes after wrong tokens ("Too many wrong admin tokens" on the admin page) | the sign-in throttle (§5): wait 10 minutes. Behind a proxy, check `trustedProxies` (otherwise every client shares the proxy's address); the log's "admin auth failed" warnings show where the attempts came from |
| An Android 7 TV cannot reach an HTTPS server | a certificate from a CA other than the TV's or Let's Encrypt's roots; use Caddy's default issuer |
| The TV app tab says "last check failed" | the server cannot reach GitHub (firewall, § 7), or the release has no `izle-tv-X.Y.Z.apk` (no signing key in the repository); upload the APK instead |
| A TV stays on "needs Install now" although it runs Android 12+ | "Install unknown apps" was not allowed for izle (§ 8), or the TV refused a silent install once: press **Install now** and allow it on the TV |
| An update fails with `install_failure_incompatible` | the APK is signed with another key than the installed app (a debug APK over a release one, or a new release key): uninstall and install again, then pair again |
