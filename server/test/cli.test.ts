import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { main } from "../src/cli.ts";
import { localServerUrl } from "../src/config.ts";
import { linkBase, qrCode, signInLink } from "../src/shell.ts";
import { MIGRATIONS } from "../src/store/schema.ts";
import { ADMIN_TOKEN, testServer, tempDir } from "./helpers.ts";

// The CLI reads the admin token the way the server does; the test server runs with the token from the environment.
process.env.IZLE_ADMIN_TOKEN = ADMIN_TOKEN;

/** Runs the CLI in-process, capturing what it prints. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => ((err += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** Runs the CLI and checks its exit status and, when given, what it printed on stderr. */
async function refused(argv: string[], code: number, err?: RegExp, message?: string): Promise<void> {
  const r = await run(argv);
  assert.equal(r.code, code, message ?? r.err);
  if (err) assert.match(r.err, err);
}

test("cli: pair pending / pair approve drive the running server's admin API", async (t) => {
  const s = await testServer(t);
  const cfg = ["--config", s.config.configPath!, "--server", s.base];

  let r = await run(["pair", "pending", ...cfg]);
  assert.equal(r.code, 0);
  assert.match(r.out, /no TV is waiting/);

  const first = await s.call("POST", "/api/v1/pair/start");
  const second = await s.call("POST", "/api/v1/pair/start");
  r = await run(["pair", "pending", ...cfg]);
  assert.equal(r.code, 0);
  // The test server's clock is frozen in the past, so the countdown (computed against the real clock) is 0:00 here.
  assert.match(r.out, new RegExp(`^${first.json.code}  waiting for approval, expires in \\d+:\\d\\d$`, "m"));
  assert.match(r.out, new RegExp(`^${second.json.code}  waiting`, "m"));

  r = await run(["pair", "approve", first.json.code, "Living", "room", ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^approved: "Living room" \([A-Za-z0-9]{12}\) shows its home screen in a moment/m, "unquoted words make up the name");
  r = await run(["pair", "approve", second.json.code, ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^approved: "TV" /m, "the name is optional");
  // The test clock is frozen, so the list order (creation time, then id) is not meaningful: sort by name.
  const devices = (await s.admin("GET", "/devices")).json.devices.map((d: { name: string; status: string }) => [d.name, d.status]).sort();
  assert.deepEqual(devices, [["Living room", "pending"], ["TV", "pending"]]);
  r = await run(["pair", "pending", ...cfg]);
  assert.match(r.out, new RegExp(`^${first.json.code}  approved, waiting for the TV to collect its token$`, "m"));
  await refused(["pair", "approve", first.json.code, ...cfg], 1, /already approved/);

  // The TV's long-poll was woken through the server, like an approval from the admin page.
  const wait = await s.call("GET", `/api/v1/pair/wait?code=${first.json.code}&wait=0`, { token: first.json.pairToken });
  assert.equal(wait.json.status, "approved");
  await refused(["pair", "approve", first.json.code, ...cfg], 1, /no TV is waiting with the code/, "a collected code is gone");
  await refused(["pair", "approve", "000000", ...cfg], 1, /no TV is waiting with the code 000000/);
  await refused(["pair", "approve", "12ab", ...cfg], 1, /6-digit code/);
  const unreachable = ["--config", s.config.configPath!, "--server", "http://127.0.0.1:1"];
  await refused(["pair", "approve", "123456", ...unreachable], 1, /no izle server answers at http:\/\/127\.0\.0\.1:1; is it running\?/);
  await refused(["pair", "nonsense", ...cfg], 2);

  // pair cancel: a code none of the owner's TVs shows stops pairing.
  const stray = await s.call("POST", "/api/v1/pair/start");
  r = await run(["pair", "cancel", stray.json.code, ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^cleared: the code ${stray.json.code} no longer pairs`, "m"));
  assert.equal((await s.call("GET", `/api/v1/pair/wait?code=${stray.json.code}&wait=0`, { token: stray.json.pairToken })).status, 410);
  await refused(["pair", "cancel", stray.json.code, ...cfg], 1, new RegExp(`no code ${stray.json.code} is waiting`));
  await refused(["pair", "cancel", "12ab", ...cfg], 1, /one 6-digit code/);
  await refused(["pair", "cancel", "123456", "654321", ...cfg], 1, /one 6-digit code/);
  await refused(["pair", "approve", "123456", "--config", s.config.configPath!, "--server", "ftp://x"], 2);
  await refused(["admin-token", "--config", s.config.configPath!, "--server", s.base], 2, /--server belongs to the pair and token commands/);
  await refused(["check-resolver", "extra", "--config", s.config.configPath!], 2, undefined, "stray arguments are still refused");
});

test("cli: token create / list / revoke drive the running server's admin API; the secret is printed once, on stdout", async (t) => {
  const s = await testServer(t);
  const cfg = ["--config", s.config.configPath!, "--server", s.base];

  let r = await run(["token", "list", ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^no access tokens; create one with/);

  await refused(["token", "create", "Kitchen", "agent", ...cfg], 1, /needs --scope read\|control\|manage/);
  await refused(["token", "create", "--scope", "read", ...cfg], 1, /needs a name/);
  await refused(["token", "list", "--scope", "read", ...cfg], 2, /--scope belongs to token create/);
  await refused(["token", "frob", ...cfg], 2, /token needs "create/);
  await refused(["pair", "pending", "--scope", "read", ...cfg], 2, /--scope belongs to the token command/);

  r = await run(["token", "create", "Kitchen", "agent", "--scope", "control", ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^izat_[A-Za-z0-9_-]{43}\n$/, "the secret alone on stdout, like admin-token");
  assert.match(r.err, /^created access token "Kitchen agent" \([A-Za-z0-9]{12}, scope control\); its secret, shown only now:\n$/);
  const secret = r.out.trim();
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: secret })).status, 200);
  await refused(["token", "create", "Kitchen agent", "--scope", "read", ...cfg], 1, /an access token named "Kitchen agent" exists/);

  r = await run(["token", "list", ...cfg]);
  assert.equal(r.code, 0);
  const [, id] = /^([A-Za-z0-9]{12})  control  last used \S+  Kitchen agent$/m.exec(r.out) ?? [];
  assert.ok(id, r.out);
  assert.ok(!r.out.includes("izat_"), "the list never has secrets");

  await refused(["token", "revoke", "nope", ...cfg], 1, /no access token with the id nope/);
  r = await run(["token", "revoke", id!, ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `revoked access token ${id}; requests with it answer 401 from now on\n`);
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: secret })).status, 401);
  assert.ok(!s.logs.some((l) => l.includes(secret)), "the server never logged the secret");
});

test("cli: pair approve against a wrong admin token is reported, not retried", async (t) => {
  const s = await testServer(t);
  const start = await s.call("POST", "/api/v1/pair/start");
  const saved = process.env.IZLE_ADMIN_TOKEN;
  process.env.IZLE_ADMIN_TOKEN = "another-token-that-is-long-enough";
  try {
    await refused(["pair", "approve", start.json.code, "--config", s.config.configPath!, "--server", s.base], 1, /did not accept the admin token/);
  } finally {
    process.env.IZLE_ADMIN_TOKEN = saved;
  }
  assert.equal((await s.admin("GET", "/pair/pending")).json.codes[0].approved, false);
});

test("cli: admin-token --link prints the sign-in link and its QR code", async (t) => {
  const s = await testServer(t, { configFile: { publicUrl: "https://izle.example.org/" } });
  const link = `https://izle.example.org/admin/#token=${ADMIN_TOKEN}`;

  let r = await run(["admin-token", "--config", s.config.configPath!]);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${ADMIN_TOKEN}\n`, "without --link only the token is printed");

  r = await run(["admin-token", "--link", "--config", s.config.configPath!]);
  assert.equal(r.code, 0, r.err);
  const [first, blank, ...qr] = r.out.split("\n");
  assert.equal(first, link, "publicUrl is the base");
  assert.equal(blank, "");
  assert.equal(qr.at(-1), "", "the QR code ends the output");
  const rows = qr.slice(0, -1);
  assert.ok(rows.length >= 20, `a QR code of ${rows.length} rows`);
  assert.ok(rows.every((row) => /^[ █▀▄]+$/.test(row)), "half-block characters only");
  assert.ok(rows.every((row) => row.length === rows[0]!.length), "square");
  assert.doesNotMatch(r.err, /note: the link/, "no note about the address when publicUrl is set");

  r = await run(["admin-token", "--link", "--base", "http://100.64.0.2:8787/", "--config", s.config.configPath!]);
  assert.equal(r.code, 0);
  assert.ok(r.out.startsWith(`http://100.64.0.2:8787/admin/#token=${ADMIN_TOKEN}\n`), "--base wins over publicUrl");
  await refused(["admin-token", "--link", "--base", "izle.example.org", "--config", s.config.configPath!], 2);
  await refused(["--link", "--config", s.config.configPath!], 2, /--link belongs to the admin-token command/);
});

test("cli: admin-token --rotate is refused while IZLE_ADMIN_TOKEN is set, and the token stays", async (t) => {
  const s = await testServer(t);
  await refused(["admin-token", "--rotate", "--config", s.config.configPath!], 1, /IZLE_ADMIN_TOKEN is set and overrides the token file.*change or remove the variable/);
  const r = await run(["admin-token", "--config", s.config.configPath!]);
  assert.deepEqual([r.code, r.out], [0, `${ADMIN_TOKEN}\n`]);
  assert.match(r.err, /note: IZLE_ADMIN_TOKEN is set and overrides the token file/);
});

test("shell helpers: local address, link base and link format", () => {
  const config = (listen: { host: string; port: number }, publicUrl: string | null = null) => ({ listen, publicUrl }) as any;
  assert.equal(localServerUrl(config({ host: "0.0.0.0", port: 8787 })), "http://127.0.0.1:8787");
  assert.equal(localServerUrl(config({ host: "::", port: 8787 })), "http://127.0.0.1:8787");
  assert.equal(localServerUrl(config({ host: "192.168.1.54", port: 8787 })), "http://192.168.1.54:8787");
  assert.equal(localServerUrl(config({ host: "fd00::5", port: 8787 })), "http://[fd00::5]:8787");

  const interfaces = () =>
    ({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "192.168.1.54", family: "IPv4", internal: false }],
    }) as any;
  assert.deepEqual(linkBase(config({ host: "0.0.0.0", port: 8787 }, "https://izle.example.org"), interfaces), { url: "https://izle.example.org", source: "publicUrl" });
  assert.deepEqual(linkBase(config({ host: "192.168.1.54", port: 8787 }), interfaces), { url: "http://192.168.1.54:8787", source: "listen.host" });
  assert.deepEqual(linkBase(config({ host: "0.0.0.0", port: 8787 }), interfaces), { url: "http://192.168.1.54:8787", source: "interface" });
  assert.deepEqual(linkBase(config({ host: "::", port: 8787 }), () => ({}) as any), { url: "http://127.0.0.1:8787", source: "loopback" });
  assert.deepEqual(linkBase(config({ host: "127.0.0.1", port: 8787 }), interfaces), { url: "http://192.168.1.54:8787", source: "interface" }, "a loopback listen host (reverse proxy setup) is not the phone's address");
  assert.deepEqual(linkBase(config({ host: "::1", port: 8787 }), () => ({}) as any), { url: "http://[::1]:8787", source: "loopback" });

  assert.equal(signInLink("https://izle.example.org///", "tok-en"), "https://izle.example.org/admin/#token=tok-en");
  assert.equal(signInLink("https://host.example.org/izle", "a b&c"), "https://host.example.org/izle/admin/#token=a%20b%26c");
  const qr = qrCode("https://izle.example.org/admin/#token=0123456789abcdefghijklmnopqrstuvwxyz0123456");
  assert.ok(qr.split("\n").length >= 20 && /█/.test(qr));
});

/** What a backup holds: its schema version, the devices and the home list. */
function readBackup(file: string) {
  const db = new DatabaseSync(file);
  try {
    return {
      schemaVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      devices: db.prepare("SELECT id, name FROM devices ORDER BY name").all().map((r) => [r.id, r.name]),
      home: db.prepare("SELECT item_id FROM home_entries ORDER BY position").all().map((r) => r.item_id),
    };
  } finally {
    db.close();
  }
}

test("cli: backup copies the running server's database; an existing file needs --force", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "film"] })).status, 200);
  const dir = await tempDir("izle-backup-");
  const target = path.join(dir, "izle-backup.db");
  const cfg = ["--config", s.config.configPath!];
  assert.ok(statSync(path.join(s.config.dataDir, "izle.db-wal")).size > 0, "the server's latest writes are still in its write-ahead log");

  let r = await run(["backup", target, ...cfg]);
  assert.equal(r.code, 0, r.err);
  const [written, reminder, end] = r.out.split("\n");
  assert.ok(written!.startsWith(`backup written to ${target} (`) && /\(\d+ KiB\)$/.test(written!), written);
  assert.equal(
    reminder,
    `not in the backup: the admin token (IZLE_ADMIN_TOKEN), the config file (${s.config.configPath}) and the catalog (${s.bundleDir}); back them up separately`,
  );
  assert.equal(end, "");
  assert.equal(statSync(target).mode & 0o777, 0o600, "only the owner can read the copy");
  // The running server holds the database open in WAL mode; what it wrote is in the copy.
  assert.deepEqual(readBackup(target), { schemaVersion: MIGRATIONS.length, devices: [[tv.deviceId, "Salon"]], home: ["show", "film"] });

  await refused(["backup", target, ...cfg], 1, /already exists; pass --force to replace it/);
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film"] })).status, 200, "the server keeps working");
  r = await run(["backup", target, "--force", ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readBackup(target).home, ["film"], "--force replaces the copy");
  assert.equal(statSync(target).mode & 0o777, 0o600);

  for (const own of ["izle.db", "izle.db-wal"]) {
    await refused(["backup", path.join(s.config.dataDir, own), "--force", ...cfg], 1, /is the database itself/, `${own} is never a target`);
  }
  await refused(["backup", dir, "--force", ...cfg], 1, /is a directory/);
  await refused(["backup", path.join(dir, "missing", "copy.db"), ...cfg], 1, /the directory .*missing does not exist/);
  assert.deepEqual(readdirSync(dir), ["izle-backup.db"], "no partial files are left behind");
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home.map((h: { itemId: string }) => h.itemId), ["film"], "the database is untouched");

  await refused(["backup", ...cfg], 2, undefined, "the file is required");
  await refused(["backup", target, "extra", ...cfg], 2);
  await refused(["admin-token", "--force", ...cfg], 2, /--force belongs to the backup command/);
});

test("cli: backup without a database says so and creates nothing", async () => {
  const dir = await tempDir("izle-backup-");
  const config = path.join(dir, "izle.json");
  await writeFile(config, JSON.stringify({ dataDir: "./data" }));
  const r = await run(["backup", path.join(dir, "copy.db"), "--config", config]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `izle-server: there is no database at ${path.join(dir, "data", "izle.db")}; the server creates it when it first starts\n`);
  assert.deepEqual(readdirSync(dir), ["izle.json"]);
});

test("cli: the server refuses a database made by a newer server", async () => {
  const dir = await tempDir("izle-newer-");
  const config = path.join(dir, "izle.json");
  await writeFile(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, dataDir: "./data", appUpdates: { source: "manual" } }));
  mkdirSync(path.join(dir, "data"));
  const newer = new DatabaseSync(path.join(dir, "data", "izle.db"));
  newer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  newer.close();
  const r = await run(["--config", config]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `izle-server: database schema version ${MIGRATIONS.length + 1} is newer than this server (${MIGRATIONS.length})\n`);
});
