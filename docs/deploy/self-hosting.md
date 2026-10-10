# Self-hosting izle

izle has two parts: **izle-server**, which runs on a machine that is always on (a home server, NAS, mini PC,
Raspberry Pi 4/5 or a small VPS), and the **Android TV app**, which talks only to that server. This guide sets up
the server as a systemd service, optionally behind Caddy for HTTPS, and installs the app on a TV.

Commands assume a Debian/Ubuntu-like Linux with systemd; adapt package names elsewhere. Throughout,
`izle-server-X.Y.Z.tgz` is the server package and `PKG=/opt/izle/lib/node_modules/@izle/server` is where it ends up.

## 1. Choose a setup

| | LAN only | HTTPS with a domain |
|---|---|---|
| TVs | at home, on the same network | anywhere (a parent's house, a holiday flat) |
| TV address | `http://192.168.1.10:8787` | `https://izle.example.org` |
| Server listens on | `0.0.0.0:8787` | `127.0.0.1:8787`, Caddy in front on 443 |
| Admin page | from the LAN | from anywhere (or LAN/VPN only, see §6) |
| Extra parts | none | a domain name, ports 80 and 443 forwarded to the server, Caddy |

On a LAN, plain HTTP is acceptable. Never expose port 8787 to the internet: without TLS the admin token and the
TVs' device tokens travel in clear text.

## 2. Install the server

**Node.js 22.13 or newer**, installed system-wide (`/usr/bin/node` or `/usr/local/bin/node`). A Node installed by
a version manager inside a home directory (nvm, mise, fnm) is invisible to the service. Use your distribution's
package if it is recent enough (`node --version`), otherwise the [nodejs.org](https://nodejs.org/en/download)
binaries or the NodeSource packages. Node 24 LTS is a good choice.

**The package:** download `izle-server-X.Y.Z.tgz` and `SHA256SUMS` from the GitHub release and check it:

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

(From a checkout instead: `npm ci && npm run pack:server` writes the same file to `dist/`.)

The package has no dependencies: the server and its libraries are bundled in one file, so installing downloads
nothing else and needs no build tools. It contains the server, the admin page, the sample catalog and the example
files used below (`deploy/`).

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

The example ([`izle.example.json`](izle.example.json)) is set up for HTTPS behind Caddy on the same machine:

| Key | Example | |
|---|---|---|
| `listen` | `127.0.0.1:8787` | use `"host": "0.0.0.0"` for the LAN-only setup |
| `publicUrl` | `https://izle.example.org` | informational for now; set it to the address TVs use |
| `trustedProxies` | `127.0.0.1`, `::1` | reverse proxies whose `X-Forwarded-For` names the real client (addresses or CIDR ranges), so the pairing rate limit counts each TV separately. Leave it empty (`[]`) when nothing sits in front of the server |
| `dataDir` | `/var/lib/izle` | database, admin token, the resolver module's directory |
| `catalog.dir` | (absent) | absent = the sample catalog in the package; see below for your own |
| `resolver` | `null` | your resolver module, see below |
| `defaults` | `en` / `en` | menu and audio language for TVs without their own setting (`tr` for Turkish) |

The full reference is in [server-api-v1.md § Configuration](../spec/server-api-v1.md#configuration). Unknown keys
are errors, and relative paths resolve against the config file's directory. The file is readable by the `izle`
group only because a resolver module's `config` may contain keys.

### Your own catalog

A catalog bundle is a directory (`bundle.json`, `items.json`, `assets/`; see
[catalog-bundle-v1.md](../spec/catalog-bundle-v1.md)). Keep it outside the package, for example in `/srv/izle`,
owned by root and readable by everyone. The server only reads it.

```bash
sudo install -d -m 0755 /srv/izle
sudo cp -r ./my-catalog /srv/izle/catalog
/opt/izle/bin/izle-server validate-catalog /srv/izle/catalog
```

Then add `"catalog": { "dir": "/srv/izle/catalog" }` to the config. To publish a new build of the catalog, copy it
next to the old one, validate it, swap the directories, and run `sudo systemctl reload izle` (or press **Reload
from disk** on the admin page's Catalog tab). An invalid bundle is refused and the previous one stays active.
Progress and home lists survive new builds because catalog ids are durable.

### A resolver module

Catalogs whose streams are resolved at play time need the owner's resolver module
([resolver-module-v1.md](../spec/resolver-module-v1.md),
[example](../../server/examples/resolver-example/README.md)). It is plain JavaScript (an ES module; the package
does not run TypeScript) loaded from a local path. The server never downloads code. Put it in
`/srv/izle/resolver/`, owned by root, and configure it:

```json
"resolver": { "module": "/srv/izle/resolver/index.js", "config": { } }
```

The module may write only to its own directory, `/var/lib/izle/resolver` (`ctx.dataDir`). Check it, and that it
provides every adapter the catalog needs:

```bash
sudo -u izle /opt/izle/bin/izle-server check-resolver --config /etc/izle/izle.json
```

## 4. Run it with systemd

```bash
sudo install -m 0644 $PKG/deploy/izle.service /etc/systemd/system/izle.service
sudo systemctl daemon-reload
sudo systemctl enable --now izle
systemctl status izle
curl -s http://127.0.0.1:8787/healthz          # {"ok":true}
```

The unit ([`izle.service`](izle.service)) runs the server as `izle` with a tight sandbox (`systemd-analyze security
izle` rates it around 1.4, "OK"): the whole file system is read-only except `/var/lib/izle`, home directories are hidden,
and there are no capabilities and no privileged system calls. Keep the catalog and resolver module outside
`/home` for that reason. If `node` is not on systemd's default `PATH`, give its full path:
`ExecStart=/usr/local/bin/node /opt/izle/bin/izle-server --config /etc/izle/izle.json` (`sudo systemctl edit
--full izle`).

- **Logs:** one JSON object per line: `journalctl -u izle -f`, or only problems:
  `journalctl -u izle -o cat | jq -c 'select(.level != "info")'`. The log never contains stream URLs, upstream
  headers or tokens. On Node 22 a single "SQLite is an experimental feature" warning at start is expected.
- **Catalog reload:** `sudo systemctl reload izle` (SIGHUP).
- **Restart after a config change:** `sudo systemctl restart izle`. TVs reconnect on their own.

## 5. The admin token and the admin page

The first start creates a random admin token in `/var/lib/izle/admin.token` (mode 0600). Print it with:

```bash
sudo -u izle /opt/izle/bin/izle-server admin-token --config /etc/izle/izle.json
```

Open `http://<server>:8787/admin/` (or `https://izle.example.org/admin/`) and sign in with it. Treat it like a
password: it controls every TV. The page keeps it in the browser's local storage, so use **Sign out** on shared
computers. To replace it (every signed-in browser has to sign in again):

```bash
sudo -u izle /opt/izle/bin/izle-server admin-token --config /etc/izle/izle.json --rotate
sudo systemctl restart izle
```

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
  or a VPN such as WireGuard/Tailscale). TVs never use those routes, so this does not affect them.

Another reverse proxy works too if it does the same: no response buffering for `/api/v1/tv/events` (nginx:
`proxy_buffering off;`), read timeouts above 60 s (the server sends an event-stream ping every 20 s), and the
client address in `X-Forwarded-For`.

Older TVs: Android 7.0 does not know Let's Encrypt's root certificates. The app carries them itself, so a TV on
7.0 works with a Caddy certificate too.

## 7. Firewall

- **LAN only:** allow port 8787 from your LAN and nothing else, e.g. with ufw:
  `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.
- **With Caddy:** allow 80 and 443 (`sudo ufw allow 80,443/tcp`). Port 8787 needs no rule: the server listens on
  127.0.0.1 only.
- The server makes outgoing connections only for resolver modules and the media proxy (to the upstream hosts your
  catalog uses). TVs fetch direct (non-proxied) streams themselves.

## 8. Install the TV app

The release has two APKs:

- **`izle-tv-X.Y.Z.apk`**, signed with the project's release key (present when the release workflow has one; see
  [releasing.md](../releasing.md)). Use this one on a TV: every later release installs over it and keeps the
  pairing.
- **`izle-tv-X.Y.Z-debug.apk`**, for trying izle and for the emulator. It is signed with a throwaway key, so a later
  APK cannot be installed over it: uninstall it first, and the TV has to be paired again (as a new TV). Its server
  address field starts with the emulator's `http://10.0.2.2:8787`.

If there is no release key, build a signed APK yourself as described in [releasing.md](../releasing.md#android-release-signing).

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
then shows a 6-digit pairing code. On the admin page (**TVs**), give the waiting code a name and approve it, then
add shows to that TV's home screen. The tiles appear on the TV right away. Put izle first in the TV launcher's
favourites so it is the first thing on screen.

## 9. Docker (alternative to systemd)

The repository's [`Dockerfile`](../../Dockerfile) builds an image from the same package (Node 24, runs as an
unprivileged user, data in a volume):

```bash
docker build -t izle-server .
docker run -d --name izle --restart unless-stopped -p 8787:8787 -v izle-data:/var/lib/izle izle-server
docker exec izle izle-server admin-token --config /etc/izle/izle.json
```

Without further options it serves the sample catalog. For your own catalog, mount it and a config file:

```bash
docker run -d --name izle --restart unless-stopped -p 8787:8787 \
  -v izle-data:/var/lib/izle \
  -v /srv/izle/catalog:/srv/izle/catalog:ro \
  -v /etc/izle/izle.json:/etc/izle/izle.json:ro \
  izle-server
```

with `"listen": { "host": "0.0.0.0", "port": 8787 }`, `"dataDir": "/var/lib/izle"` and
`"catalog": { "dir": "/srv/izle/catalog" }` in that file. `docker kill -s HUP izle` reloads the catalog. Behind a
reverse proxy in another container, publish no port (or bind it to `127.0.0.1:8787:8787`) and set
`trustedProxies` to the Docker network's range, e.g. `["172.16.0.0/12"]`. To update, rebuild the image from the
new release's sources and recreate the container. The volume keeps the data.

## 10. Updates and backups

**Back up** `/var/lib/izle` (database and admin token), `/etc/izle` and `/srv/izle`. The database uses SQLite's
write-ahead log, so copy it while the service is stopped:

```bash
sudo systemctl stop izle
sudo tar -C / -czf izle-backup-$(date +%F).tgz var/lib/izle etc/izle srv/izle   # leave out what you do not have
sudo systemctl start izle
```

**Update the server:**

```bash
sudo npm install --global --prefix /opt/izle ./izle-server-X.Y.Z.tgz
sudo systemctl restart izle
journalctl -u izle -n 5 -o cat                  # "listening" with the new version
```

The database is migrated on start. An older server refuses a database a newer one has migrated, so to go back,
install the older package **and** restore the backup taken before the update. The admin page's Catalog tab shows
the running server version.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `status=203/EXEC` in `systemctl status izle` | `node` is not on the service's `PATH` (installed in a home directory); see §4 |
| The service exits with `EACCES` | the catalog, resolver module or config is not readable by the `izle` user |
| "the catalog bundle is invalid" | run `izle-server validate-catalog <dir>` for the full report |
| The TV shows "No connection" behind a proxy | buffering or a short timeout on `/api/v1/tv/events`; `curl -N https://<domain>/api/v1/tv/events` should answer `401` at once, not hang |
| The TV's pairing screen says to wait, and the log shows `429` on `/api/v1/pair/start` | many pairing attempts from one address; behind a proxy, check `trustedProxies` |
| An Android 7 TV cannot reach an HTTPS server | a certificate from a CA other than the TV's or Let's Encrypt's roots; use Caddy's default issuer |
