import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { main } from "../src/cli.ts";
import { linkBase, localServerUrl, qrCode, signInLink } from "../src/shell.ts";
import { SCHEMA_VERSION } from "../src/store.ts";
import { ADMIN_TOKEN, startTestServer, tempDir } from "./helpers.ts";

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

test("cli: pair pending / pair approve drive the running server's admin API", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
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
  r = await run(["pair", "approve", first.json.code, ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already approved/);

  // The TV's long-poll was woken through the server, like an approval from the admin page.
  const wait = await s.call("GET", `/api/v1/pair/wait?code=${first.json.code}&wait=0`, { token: first.json.pairToken });
  assert.equal(wait.json.status, "approved");
  r = await run(["pair", "approve", first.json.code, ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no TV is waiting with the code/, "a collected code is gone");
  r = await run(["pair", "approve", "000000", ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no TV is waiting with the code 000000/);
  r = await run(["pair", "approve", "12ab", ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /6-digit code/);
  r = await run(["pair", "approve", "123456", "--config", s.config.configPath!, "--server", "http://127.0.0.1:1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no izle server answers at http:\/\/127\.0\.0\.1:1; is it running\?/);
  r = await run(["pair", "nonsense", ...cfg]);
  assert.equal(r.code, 2);
  r = await run(["pair", "approve", "123456", "--config", s.config.configPath!, "--server", "ftp://x"]);
  assert.equal(r.code, 2);
  r = await run(["admin-token", "--config", s.config.configPath!, "--server", s.base]);
  assert.equal(r.code, 2, "--server belongs to pair");
  assert.match(r.err, /--server belongs to the pair command/);
  r = await run(["check-resolver", "extra", "--config", s.config.configPath!]);
  assert.equal(r.code, 2, "stray arguments are still refused");
});

test("cli: pair approve against a wrong admin token is reported, not retried", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const start = await s.call("POST", "/api/v1/pair/start");
  const saved = process.env.IZLE_ADMIN_TOKEN;
  process.env.IZLE_ADMIN_TOKEN = "another-token-that-is-long-enough";
  try {
    const r = await run(["pair", "approve", start.json.code, "--config", s.config.configPath!, "--server", s.base]);
    assert.equal(r.code, 1);
    assert.match(r.err, /did not accept the admin token/);
  } finally {
    process.env.IZLE_ADMIN_TOKEN = saved;
  }
  assert.equal((await s.admin("GET", "/pair/pending")).json.codes[0].approved, false);
});

test("cli: admin-token --link prints the sign-in link and its QR code", async (t) => {
  const s = await startTestServer({ configFile: { publicUrl: "https://izle.example.org/" } });
  t.after(() => s.close());
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
  r = await run(["admin-token", "--link", "--base", "izle.example.org", "--config", s.config.configPath!]);
  assert.equal(r.code, 2);
  r = await run(["--link", "--config", s.config.configPath!]);
  assert.equal(r.code, 2, "--link belongs to admin-token");
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
      eth0: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.54", family: "IPv4", internal: false },
      ],
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
  const s = await startTestServer();
  t.after(() => s.close());
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
  assert.deepEqual(readBackup(target), { schemaVersion: SCHEMA_VERSION, devices: [[tv.deviceId, "Salon"]], home: ["show", "film"] });

  r = await run(["backup", target, ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; pass --force to replace it/);
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film"] })).status, 200, "the server keeps working");
  r = await run(["backup", target, "--force", ...cfg]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readBackup(target).home, ["film"], "--force replaces the copy");
  assert.equal(statSync(target).mode & 0o777, 0o600);

  for (const own of ["izle.db", "izle.db-wal"]) {
    r = await run(["backup", path.join(s.config.dataDir, own), "--force", ...cfg]);
    assert.equal(r.code, 1, `${own} is never a target`);
    assert.match(r.err, /is the database itself/);
  }
  r = await run(["backup", dir, "--force", ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /is a directory/);
  r = await run(["backup", path.join(dir, "missing", "copy.db"), ...cfg]);
  assert.equal(r.code, 1);
  assert.match(r.err, /the directory .*missing does not exist/);
  assert.deepEqual(readdirSync(dir), ["izle-backup.db"], "no partial files are left behind");
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home.map((h: { itemId: string }) => h.itemId), ["film"], "the database is untouched");

  assert.equal((await run(["backup", ...cfg])).code, 2, "the file is required");
  assert.equal((await run(["backup", target, "extra", ...cfg])).code, 2);
  r = await run(["admin-token", "--force", ...cfg]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--force belongs to the backup command/);
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
