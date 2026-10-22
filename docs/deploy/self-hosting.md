# Self-hosting izle

izle has two parts: **izle-server**, on a machine that is always on (a home server, NAS, mini PC, Raspberry Pi 4/5
or a small VPS), and the **Android TV app**, which talks only to that server. This guide runs the server as a
systemd service, optionally behind Caddy for HTTPS, on a Debian/Ubuntu-like Linux; `izle-server-X.Y.Z.tgz` is the
server package and `PKG=/opt/izle/lib/node_modules/@izle/server` is where it ends up.

## 1. Choose a setup

| | LAN only | HTTPS with a domain |
|---|---|---|
| TVs | at home, on the same network | anywhere (a parent's house, a holiday flat) |
| TV address | `http://192.168.1.10:8787` | `https://izle.example.org` |
| Server listens on | `0.0.0.0:8787` | `127.0.0.1:8787`, Caddy in front on 443 |
| Admin page | from the LAN | from anywhere (or LAN/VPN only, see §6) |
| Extra parts | none | a domain name, ports 80 and 443 forwarded to the server, Caddy |

Never expose port 8787 to the internet: without TLS the admin token and the TVs' device tokens travel in clear text.

## 2. Install the server

**Node.js 22.13 or newer** (Node 24 LTS is a good choice), installed system-wide (`/usr/bin/node` or
`/usr/local/bin/node`): the service cannot see a Node that a version manager (nvm, mise, fnm) installed in a home
directory. Use your distribution's package if recent enough, else the [nodejs.org](https://nodejs.org/en/download)
binaries or the NodeSource packages.

**The package:** download `izle-server-X.Y.Z.tgz` and `SHA256SUMS` from the GitHub release and check them with
`sha256sum --check --ignore-missing SHA256SUMS` (in a checkout, `npm ci && npm run pack:server` writes it to `dist/`).
It is one bundled file with the admin page, the sample catalog and the files under `deploy/` used below, so
installing downloads nothing else and needs no build tools.

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
([`izle.example.json`](izle.example.json)) is for HTTPS behind Caddy on the same machine: for the LAN-only setup set
`"host": "0.0.0.0"` and `trustedProxies` `[]`; `publicUrl` is the address izle is reached at (§5); `dataDir`
`/var/lib/izle` holds the database, the admin token, the resolver module's directory and the TV app's APK; `defaults`
sets the menu and audio language of TVs without their own (`tr` for Turkish); `"appUpdates": {"source": "manual"}`
stops fetching the TV app from GitHub (§8). Every key:
[server API § Configuration](../spec/server-api-v1.md#configuration).

### Your own catalog

A catalog bundle is a directory (`bundle.json`, `items.json`, `assets/`;
[catalog-bundle-v1.md](../spec/catalog-bundle-v1.md)). Keep it outside the package, under `/srv/izle`, readable by
everyone; the server only reads it. Keep every build in its own directory (the bundle's `buildId` is a convenient
name) and a relative symlink, `current`, on the active one (relative, so it also resolves inside a container, §9):

```
/srv/izle/catalog/
  builds/20261012-1a2b3c4d5e6f/      bundle.json, items.json, assets/
  builds/20261014-7a8b9c0d1e2f/
  current -> builds/20261014-7a8b9c0d1e2f
```

To add a build (the first one too), copy it next to the others, validate it, swap the link in one step (`mv -T`,
so the server never sees a half-copied build) and reload (once the service runs, §4; or **Reload from disk** on the
admin page's Catalog tab). The config then needs `"catalog": { "dir": "/srv/izle/catalog/current" }`.

```bash
B=20261014-7a8b9c0d1e2f
sudo install -d -m 0755 /srv/izle /srv/izle/catalog /srv/izle/catalog/builds
sudo cp -r ./my-catalog /srv/izle/catalog/builds/$B
/opt/izle/bin/izle-server validate-catalog /srv/izle/catalog/builds/$B
sudo ln -sfn builds/$B /srv/izle/catalog/current.new
sudo mv -T /srv/izle/catalog/current.new /srv/izle/catalog/current
sudo systemctl reload izle
```

- **An invalid bundle is refused** on reload and the previous build stays active, but `systemctl reload` does not
  tell you: check `journalctl -u izle -n 5` (the admin page's button lists the problems). Then point `current` back:
  the server reads posters through the link, and a restart would load whatever it points at.
- **To roll back**, point `current` at an older build and reload. Delete old builds once you no longer need them.
  Progress and home lists survive builds because catalog ids are durable.

### A resolver module

Catalogs whose streams are resolved at play time need the owner's resolver module
([resolver-module-v1.md](../spec/resolver-module-v1.md), [example](../../server/examples/resolver-example/README.md)):
plain JavaScript (the package does not run TypeScript). Put it in `/srv/izle/resolver/`, owned by root, configure
`"resolver": { "module": "/srv/izle/resolver/index.js", "config": { } }` and check it (and the catalog's adapters):

```bash
sudo -u izle /opt/izle/bin/izle-server check-resolver --config /etc/izle/izle.json
```

The module may write only to `/var/lib/izle/resolver` (`ctx.dataDir`). It is loaded once, at start: **a new module
needs `sudo systemctl restart izle`**, and a reload refuses a build that needs an adapter the running module lacks,
so install and check the module first, then restart.

### Letting a job on the host publish builds

A script or timer on the same machine can publish builds without sudo: give it its own system user that owns
`/srv/izle/catalog` and a copy of the admin token, and let it reload through the admin API. Once the service runs
(§4) and has created its token (§5):

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/izle-publish --shell /usr/sbin/nologin izle-publish
sudo chown -R izle-publish:izle-publish /srv/izle/catalog
sudo install -m 0600 -o izle-publish -g izle-publish /var/lib/izle/admin.token /var/lib/izle-publish/admin.token
```

With the default umask of 022 the job's builds are readable by the service, which stays read-only on `/srv`; the job
never writes `/var/lib/izle`. Copy the token again after `admin-token --rotate`. A reload re-hashes every poster, so
allow a generous timeout (after one, `GET /api/v1/admin/catalog` shows which `buildId` is active). Fail on `401`
without retrying: wrong tokens count towards the sign-in throttle (§5), which also blocks `izle-server pair` here. A
publish step (`publish <buildId>`, once the build is in `builds/<buildId>/`):

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
curl -s http://127.0.0.1:8787/healthz          # {"ok":true}
```

The unit ([`izle.service`](izle.service)) runs the server as `izle` in a tight sandbox (`systemd-analyze security
izle` rates it around 1.4, "OK"): the file system is read-only except `/var/lib/izle`, home directories are hidden
(keep the catalog and resolver module outside `/home`), no capabilities, no privileged system calls. If `node` is not
on systemd's default `PATH`, set `ExecStart=/usr/local/bin/node /opt/izle/bin/izle-server --config
/etc/izle/izle.json` with `sudo systemctl edit --full izle`.

- **Logs:** `journalctl -u izle -f`, or only problems: `journalctl -u izle -o cat | jq -R -c 'fromjson? | select(.level
  != "info")'`. On Node 22 one "SQLite is an experimental feature" warning at start is expected.
- **`sudo systemctl reload izle`** (SIGHUP) re-reads the catalog only; **restart** after a config change or a new
  resolver module. TVs reconnect on their own.

## 5. The admin token and the admin page

The first start creates a random admin token in `/var/lib/izle/admin.token`. Print it and sign in at
`http://<server>:8787/admin/` (or `https://izle.example.org/admin/`); it controls every TV, and the page keeps it in
the browser's local storage, so use **Sign out** on shared computers. Add `--link` (with `publicUrl`, or `--base
<url>`) for a sign-in link and its QR code (drawn for a dark terminal), to open on a phone: the token sits in the URL
fragment, which browsers never send, the page removes it once signed in, and the link is as secret as the token.
`--rotate` replaces it with a new random one (restart; every browser signs in again).

```bash
sudo -u izle /opt/izle/bin/izle-server admin-token --config /etc/izle/izle.json      # or with --link, --rotate
```

**A passphrase instead:** any token of 24 or more characters without spaces works. Write it to the token file and
restart: `echo 'correct-horse-battery-staple-9' | sudo -u izle tee /var/lib/izle/admin.token > /dev/null`.

**Never put `IZLE_ADMIN_TOKEN` in the unit with `Environment=`** (also not in a `systemctl edit` drop-in): systemd
shows it to every local user (`systemctl show izle`). If you need the variable, keep it in a root-only file named by
`EnvironmentFile=`, and remember that the shell commands need it too. While it is set, it is the token and
`--rotate` refuses (the server warns at startup when it shadows a token file).

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/izle/admin.env
echo 'IZLE_ADMIN_TOKEN=correct-horse-battery-staple-9' | sudo tee /etc/izle/admin.env > /dev/null
sudo systemctl edit izle    # add:  [Service]  EnvironmentFile=/etc/izle/admin.env
```

Guessing is throttled: 10 wrong tokens from one address within 10 minutes lock that address out of the admin API for
those 10 minutes, even with the right token; each is logged as "admin auth failed" with the address.

**Access tokens** keep the admin token out of scripts: an app, a home-automation hook or an AI agent gets its own,
scoped `read`, `control` (plus commands) or `manage` (plus home screens, settings and history marks), under
**Access** on the admin page or with `izle-server token create "Home assistant" --scope control --config
/etc/izle/izle.json` (the secret, `izat_…`, is printed once); `token list` and `token revoke <id>`. A revoked token
counts as a wrong one for the throttle, so stop the app before revoking it. What each scope can call:
[server API § Remote management](../spec/server-api-v1.md#remote-management).

## 6. HTTPS with Caddy

You need a domain whose DNS A/AAAA record points at your public address, and ports 80 and 443 forwarded to the
server (Caddy gets the certificate from Let's Encrypt itself).

1. Install Caddy from your distribution or [caddyserver.com](https://caddyserver.com/docs/install).
2. `sudo cp $PKG/deploy/Caddyfile /etc/caddy/Caddyfile`, put your domain in it, `sudo systemctl reload caddy`.
3. In `/etc/izle/izle.json` keep `"host": "127.0.0.1"` and `trustedProxies` `["127.0.0.1", "::1"]`, set `publicUrl`,
   and restart izle. Check from outside: `curl https://izle.example.org/healthz`.

The [Caddyfile](Caddyfile) passes every response through as it arrives (`flush_interval -1`: the TVs' event stream,
the pairing long-poll, proxied video; Caddy has no response timeout by default), sets `Strict-Transport-Security`,
keeps no access log (paths carry proxy tokens and pairing codes) and no `encode` (it would buffer the event stream).
Caddy replaces a client's `X-Forwarded-For` with its real address. Its commented `@admin_outside` block answers the
admin page and API only from private addresses (your LAN, or a VPN such as WireGuard/Tailscale). Another reverse
proxy works if it does the same: no buffering for `/api/v1/tv/events` (nginx: `proxy_buffering off;`), read timeouts
above 60 s (the server pings every 20 s), and the client address in `X-Forwarded-For`.

## 7. Firewall

- **LAN only:** allow port 8787 from your LAN only, e.g.
  `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.
- **With Caddy:** allow 80 and 443 (`sudo ufw allow 80,443/tcp`); 8787 listens on 127.0.0.1 only.
- **Outgoing:** resolver modules and the media proxy reach your catalog's upstream hosts; with `appUpdates.source`
  `github` the server reaches `api.github.com` and GitHub's download hosts (`*.githubusercontent.com`) once a day.
  TVs fetch direct streams themselves; Listen along goes through the proxy, so the phone needs only the admin page.
- The media proxy refuses loopback, private, link-local (the cloud metadata address included) and CGNAT addresses
  (`502 egress_denied`, a problem on the TV's page). An upstream of yours on this machine or the LAN (a NAS, the
  [resolver example](../../server/examples/resolver-example/)'s stand-in site) goes in
  `"proxy": { "privateUpstreams": ["192.168.1.20", "127.0.0.1:8788"] }`; list as little as you can, since a listed
  address is open to whatever the upstream's playlists name.

## 8. Install the TV app

The release has two APKs:

- **`izle-tv-X.Y.Z.apk`**, signed with the project's release key (when the release workflow has one): use this on a
  TV; later releases install over it and keep the pairing. Without one, sign it yourself
  ([releasing.md](../releasing.md#android-release-signing)).
- **`izle-tv-X.Y.Z-debug.apk`**, for trying izle and the emulator (its address field starts with
  `http://10.0.2.2:8787`). Its throwaway key means a later APK cannot install over it: uninstall first and pair again.

**With adb over the network** (any Android TV / Google TV): on the TV, Settings → Device Preferences (or System) →
About, select the build number seven times, then turn on **USB debugging** in Developer options (newer Google TV
devices use **Wireless debugging** with a pairing code). From a computer with
[platform-tools](https://developer.android.com/tools/releases/platform-tools):

```bash
adb connect 192.168.1.20:5555          # the TV's address; accept the prompt on the TV
# Android 11+ wireless debugging instead: adb pair <ip>:<pairing port>, then adb connect <ip>:<port>
adb install -r izle-tv-X.Y.Z.apk
```

**Without a computer:** send the APK with a file-transfer app such as *Send files to TV* (on the TV and the phone),
or a USB stick, open it with a file manager and allow it to **install unknown apps**.

**First start:** enter the server address (`http://192.168.1.10:8787` or `https://izle.example.org`); the TV shows a
6-digit code and the admin page's address. Approve the code on the admin page (**TVs**; a name is optional), then
add shows to the TV's home screen. From the shell: `sudo -u izle /opt/izle/bin/izle-server pair approve 483920 Living
room --config /etc/izle/izle.json` (`pair pending` lists codes, `pair cancel <code>` clears one; `--server <url>`
when the server does not listen where the config says). Never approve a code your TV does not show; **Clear** one you
did not expect. Put izle first in the launcher's favourites.

### Updating the TV app

Only the first install is done at the TV; the server offers its current APK to every paired TV (with `"source":
"github"`, each new release's, checked daily or on **Check now** in the admin page's **TV app** tab; with
`"manual"`, the one uploaded there). A TV only installs an APK signed like the app it runs, so a debug APK cannot
update a release install. What the viewer sees: [Update](../ux/senior-tv.md#update).

- **Allow the update permission once**, right after the first install: Settings → Apps → Security & restrictions (or
  Special app access) → **Install unknown apps** → izle (Android 7: the **Unknown sources** switch).
- **Android 12+** installs by itself after three idle minutes on Home, then shows the launcher; izle runs the new
  version when next opened. **Android 11 and older** (the Freebox Player Mini, for example) need someone at the TV
  when you press **Install now**: OK, then the system dialog's **Update** (it may start on Cancel); 10 and 11 then
  show the launcher too, 9 and older bring izle back.
- The outcome comes back as the command's result; pairing, home screen and progress are kept.

## 9. Docker (alternative to systemd)

The repository's [`Dockerfile`](../../Dockerfile) builds an image from the same package (Node 26, an unprivileged
user, data in a volume). Without options it serves the sample catalog:

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
`"catalog": { "dir": "/srv/izle/catalog/current" }` (mount the whole `/srv/izle/catalog` so the relative link
resolves). `docker kill -s HUP izle` reloads the catalog; a new resolver module (mounted the same way) needs `docker
restart izle`. Behind a reverse proxy in another container, publish no port (or `127.0.0.1:8787:8787`) and set
`trustedProxies` to the Docker network's range, e.g. `["172.16.0.0/12"]`. To update, rebuild from the new release's
sources and recreate the container; the volume keeps the data. A container without outgoing network access needs
`"appUpdates": { "source": "manual" }`.

## 10. Updates and backups

**Back up** the database, the admin token (`/var/lib/izle/admin.token`), `/etc/izle` and `/srv/izle`. Copy the
database with `izle-server backup`, a consistent snapshot while the service runs (copying `izle.db` by hand misses
recent changes in `izle.db-wal`); the copy is one file, readable by `izle` only:

```bash
sudo -u izle mkdir -p /var/lib/izle/backups
sudo -u izle /opt/izle/bin/izle-server backup --config /etc/izle/izle.json /var/lib/izle/backups/izle-$(date +%F).db
```

**Daily:** the package's [`izle-backup.service`](izle-backup.service) and [`izle-backup.timer`](izle-backup.timer)
write such a copy daily and delete those older than 30 days; let your backup tool pick up `/var/lib/izle/backups`.

```bash
sudo install -m 0644 $PKG/deploy/izle-backup.service $PKG/deploy/izle-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now izle-backup.timer
sudo systemctl start izle-backup && ls -l /var/lib/izle/backups      # a first copy right away
```

**With Docker:** `docker exec izle izle-server backup --force --config /etc/izle/izle.json /var/lib/izle/backup.db &&
docker cp izle:/var/lib/izle/backup.db ./izle-$(date +%F).db` (`--force` replaces an existing file).

**Restore** with the service stopped, removing the write-ahead files so they are not applied to the restored copy.
TVs paired after the copy was taken pair again.

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

A new version may upgrade the database, which an older server then refuses: to go back, install the older package
**and** restore `before-X.Y.Z.db`. The Catalog tab shows the running version. Update the server before the TVs (an
older server may reject a newer app's fields, losing the first report after each start), then the TVs (§8).

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
| An Android 7 TV cannot reach an HTTPS server | a certificate from a CA other than the TV's or Let's Encrypt's roots (which the app carries); use Caddy's default issuer |
| The TV app tab says "last check failed" | the server cannot reach GitHub (firewall, § 7), or the release has no `izle-tv-X.Y.Z.apk` (no signing key in the repository); upload the APK instead |
| A TV stays on "needs Install now" although it runs Android 12+ | "Install unknown apps" was not allowed for izle (§ 8), or the TV refused a silent install once: press **Install now** and allow it on the TV |
| An update fails with `install_failure_incompatible` | the APK is signed with another key than the installed app (a debug APK over a release one, or a new release key): uninstall and install again, then pair again |
