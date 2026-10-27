// App cards: a TV's list of its installed apps and their pictures (stored, served, deleted once no one names them),
// the owner's app cards on Home (single changes, `PUT …/home` keeping them, sections), what the TV's state and the
// admin page make of them, and the migration that brought them to a database with a Home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_IMAGE_MAX_BYTES } from "../src/apps.ts";
import { HOME_MAX_APPS } from "../src/home.ts";
import { Store } from "../src/store.ts";
import { MIGRATIONS } from "../src/store/schema.ts";
import { fixtureItems, fixtureManifest, section, tempDir, testServer, writeBundle, type Json, type TestServer } from "./helpers.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes that start like a PNG (all the server checks), distinct each time. */
const png = (size = 64) => Buffer.concat([PNG_SIGNATURE, randomBytes(size)]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const WEATHER = "com.example.weather";
const NEWS = "com.example.news";
const RADIO = "org.example.radio_player";

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const images = { weather: png(), news: png(), radio: png() };
  return { s, tv, images, ...calls(s, tv) };
}

function calls(s: TestServer, tv: { deviceId: string; token: string }) {
  const report = (apps: unknown, token = tv.token) => s.call("PUT", "/api/v1/tv/apps", { token, body: { apps } });
  const upload = async (hash: string, body: Uint8Array, o: { token?: string; type?: string } = {}) => {
    const res = await fetch(`${s.base}/api/v1/tv/apps/images/${hash}`, {
      method: "PUT", headers: { Authorization: `Bearer ${o.token ?? tv.token}`, "Content-Type": o.type ?? "image/png" }, body,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const home = (method: string, route: string, body?: unknown) => s.admin(method, `/devices/${tv.deviceId}/home${route}`, body);
  const detail = async () => (await s.admin("GET", `/devices/${tv.deviceId}`)).json;
  const state = async () => (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json;
  const events = async (type: string) => (await s.admin("GET", `/events?after=0&types=${type}&limit=500`)).json.events as Json[];
  return { report, upload, home, detail, state, events };
}

const three = (images: { weather: Buffer; news: Buffer; radio: Buffer }) => [
  { appId: WEATHER, label: " Weather ", image: sha(images.weather) },
  { appId: NEWS, label: "News", image: sha(images.news) },
  { appId: RADIO, label: "Radio", image: null },
];

/** The sections as `[id, entries]`, each entry `i:<itemId>` or `a:<appId>`. */
const cards = (sections: Json[]) => sections.map((x) => [x.id, x.entries.map((e: Json) => (e.appId ? `a:${e.appId}` : `i:${e.itemId}`))]);

test("PUT /tv/apps: the TV's list in its order, labels trimmed; device.apps only when it changed; the pictures still missing", async (t) => {
  const { s, tv, images, report, detail, events } = await setup(t);
  const before = await detail();
  assert.deepEqual([before.apps, before.appsMax, before.appsReportedAt], [[], HOME_MAX_APPS, null], "a TV that never reported has no list");

  const r = await report(three(images));
  assert.deepEqual([r.status, r.json], [200, { missingImages: [sha(images.weather), sha(images.news)] }]);
  const d = await detail();
  assert.deepEqual(d.apps, [
    { appId: WEATHER, label: "Weather", imageUrl: null, installed: true, onHome: false },
    { appId: NEWS, label: "News", imageUrl: null, installed: true, onHome: false },
    { appId: RADIO, label: "Radio", imageUrl: null, installed: true, onHome: false },
  ], "a picture not uploaded yet has no URL");
  assert.equal(d.appsReportedAt, "2026-10-10T12:00:00.000Z");
  assert.equal(d.device.stateVersion, before.device.stateVersion, "the TV's state did not change");

  s.clock.advance(60_000);
  assert.deepEqual((await report(three(images))).json, { missingImages: [sha(images.weather), sha(images.news)] }, "the same list: still missing");
  assert.equal((await detail()).appsReportedAt, "2026-10-10T12:00:00.000Z", "the same list changes nothing");
  await report([three(images)[2], { appId: NEWS, label: "News", image: sha(images.news) }, { appId: "tv.example.Games", label: "Games", image: null }]);
  assert.equal((await detail()).appsReportedAt, "2026-10-10T12:01:00.000Z");
  await report([]);
  const apps = await events("device.apps");
  assert.deepEqual(apps.map((e) => [e.deviceId, e.actor, e.data]), [
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { count: 3, added: [WEATHER, NEWS, RADIO], removed: [] }],
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { count: 3, added: ["tv.example.Games"], removed: [WEATHER] }],
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { count: 0, added: [], removed: [RADIO, NEWS, "tv.example.Games"] }],
  ]);
  assert.deepEqual([(await detail()).apps, (await detail()).appsReportedAt], [[], "2026-10-10T12:01:00.000Z"]);

  // A TV whose first list is empty has reported: the admin page tells "nothing to add" from "never listed".
  const other = await s.pair("Mutfak");
  assert.deepEqual((await report([], other.token)).json, { missingImages: [] });
  assert.equal((await s.admin("GET", `/devices/${other.deviceId}`)).json.appsReportedAt, "2026-10-10T12:01:00.000Z");
  assert.equal((await events("device.apps")).length, 4);

  const label = (n: number) => ({ appId: WEATHER, label: "x".repeat(n), image: null });
  const refused: Array<[unknown, string]> = [
    [three(images).concat([{ appId: WEATHER, label: "Again", image: null }]), "duplicate_app"],
    [Array.from({ length: 201 }, (_, i) => ({ appId: `com.example.a${i}`, label: "A", image: null })), "invalid_request"],
    [[{ appId: "weather", label: "W", image: null }], "invalid_request"],
    [[{ appId: "com.example.", label: "W", image: null }], "invalid_request"],
    [[{ appId: "1com.example", label: "W", image: null }], "invalid_request"],
    [[{ appId: `com.${"a".repeat(197)}`, label: "W", image: null }], "invalid_request"],
    [[label(0)], "invalid_request"],
    [[label(101)], "invalid_request"],
    [[{ appId: WEATHER, label: "   ", image: null }], "invalid_request"],
    [[{ appId: WEATHER, label: "W", image: sha(images.weather).toUpperCase() }], "invalid_request"],
    [[{ appId: WEATHER, label: "W", image: "abc" }], "invalid_request"],
    [[{ appId: WEATHER, label: "W" }], "invalid_request"],
    [[{ appId: WEATHER, label: "W", image: null, extra: 1 }], "invalid_request"],
  ];
  for (const [apps, error] of refused) {
    const res = await report(apps);
    assert.deepEqual([res.status, res.json.error], [400, error], JSON.stringify(apps).slice(0, 80));
  }
  assert.equal((await report(Array.from({ length: 200 }, (_, i) => ({ appId: `com.example.a${i}`, label: "A", image: null })))).status, 200, "200 apps fit");
  assert.equal((await report([{ appId: `com.${"a".repeat(196)}`, label: "x".repeat(100), image: null }])).status, 200, "an id of 200 characters, a label of 100");
  assert.equal((await s.call("PUT", "/api/v1/tv/apps", { body: { apps: [] } })).status, 401, "a TV route");
});

test("pictures: a PNG a report of this TV names, checked and stored once, served publicly and immutable; deleted once no one names it", async (t) => {
  const { s, tv, images, report, upload, detail, home } = await setup(t);
  const { store } = s.srv.ctx;
  const [w, n] = [sha(images.weather), sha(images.news)];
  assert.deepEqual((await upload(w, images.weather)).json, { error: "not_found" }, "no report names it yet");
  await report(three(images));

  const other = await s.pair("Mutfak");
  assert.equal((await upload(w, images.weather, { token: other.token })).status, 404, "another TV's report does not count");
  const refused: Array<[string, Uint8Array, string | undefined, number, string]> = [
    [w, Buffer.from("GIF89a not a png"), undefined, 400, "invalid_image"],
    [w, images.news, undefined, 400, "invalid_image"],
    [w, images.weather, "application/octet-stream", 400, "invalid_image"],
    [w, new Uint8Array(0), undefined, 400, "invalid_image"],
    [w, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(APP_IMAGE_MAX_BYTES)]), undefined, 413, "body_too_large"],
    [w.toUpperCase(), images.weather, undefined, 404, "not_found"],
    ["..%2F..%2Fizle.db", images.weather, undefined, 404, "not_found"],
  ];
  for (const [hash, body, type, status, error] of refused) {
    const r = await upload(hash, body, { type });
    assert.deepEqual([r.status, r.json?.error], [status, error], `${hash.slice(0, 12)} ${type ?? ""} ${body.byteLength}`);
  }
  assert.equal(store.getAppImage(w), null);

  const big = Buffer.concat([PNG_SIGNATURE, randomBytes(APP_IMAGE_MAX_BYTES - PNG_SIGNATURE.length)]);
  await report([...three(images), { appId: "com.example.big", label: "Big", image: sha(big) }]);
  assert.equal((await upload(sha(big), big)).status, 204, "256 KiB exactly fits");
  assert.equal((await upload(w, images.weather)).status, 204);
  assert.equal((await upload(w, images.weather)).status, 204, "again: nothing changes");
  assert.deepEqual((await report(three(images))).json, { missingImages: [n] });

  const served = await fetch(`${s.base}/app-images/${w}.png`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), images.weather);
  assert.deepEqual(
    ["content-type", "cache-control", "etag", "x-content-type-options"].map((h) => served.headers.get(h)),
    ["image/png", "public, max-age=31536000, immutable", `"${w}"`, "nosniff"],
  );
  for (const bad of [`${w.toUpperCase()}.png`, `${w}.jpg`, w, `${n}.png`, "..%2Fizle.db", `${w}.png.png`, "x.png"]) {
    assert.equal((await fetch(`${s.base}/app-images/${bad}`)).status, 404, bad);
  }
  assert.equal((await detail()).apps[0].imageUrl, `/app-images/${w}.png`);

  // Another TV names the same picture: it stays while one of the two does, or an app card does.
  await report([{ appId: WEATHER, label: "Hava", image: w }], other.token);
  assert.deepEqual((await report([{ appId: WEATHER, label: "Hava", image: w }], other.token)).json, { missingImages: [] }, "uploaded once for all TVs");
  await report([]);
  assert.ok(store.getAppImage(w), "the other TV still names it");
  await report([{ appId: WEATHER, label: "Weather", image: w }]);
  assert.equal((await home("POST", "/apps", { appId: WEATHER })).status, 200);
  assert.equal((await s.admin("DELETE", `/devices/${other.deviceId}`)).status, 204);
  await report([]);
  assert.ok(store.getAppImage(w), "an app card keeps the picture of the last report that named its app");
  assert.equal((await detail()).apps[0].imageUrl, `/app-images/${w}.png`);
  assert.equal(store.getAppImage(sha(big)), null, "the big one went when no report named it any more");
  await home("DELETE", `/apps/${WEATHER}`);
  assert.equal(store.getAppImage(w), null, "gone with the app card");
  assert.equal((await fetch(`${s.base}/app-images/${w}.png`)).status, 404);

  await report([{ appId: WEATHER, label: "Weather", image: w }]);
  await upload(w, images.weather);
  assert.equal((await s.admin("DELETE", `/devices/${tv.deviceId}`)).status, 204);
  assert.equal(store.getAppImage(w), null, "gone with the TV");
  assert.ok(!s.logs.some((l) => l.includes(w) || l.includes("Weather")), "no picture or label in the log");
});

test("app card routes: add, move, remove; position counts every card of a section; errors; answers carry the apps; home.changed says what came and went", async (t) => {
  const { s, tv, images, report, home, detail, state, events } = await setup(t);
  assert.deepEqual([(await home("POST", "/apps", { appId: WEATHER })).status, (await home("POST", "/apps", { appId: WEATHER })).json.error], [400, "unknown_app"],
    "a TV that never reported: nothing to add");
  await report(three(images));
  const v0 = (await detail()).device.stateVersion;
  const after = (await s.admin("GET", "/events")).json.last;
  const films = (await home("POST", "/sections", { title: "Films" })).json.sectionId;
  await home("PUT", "", { itemIds: ["show", "film"] });

  const added = await home("POST", "/apps", { appId: NEWS, position: 1 });
  assert.equal(added.status, 200);
  assert.deepEqual(Object.keys(added.json).sort(), ["apps", "home", "sections", "version"]);
  assert.equal(added.json.version, v0 + 3);
  assert.deepEqual(cards(added.json.sections), [["untitled", ["i:show", "a:" + NEWS, "i:film"]], [films, []]]);
  assert.deepEqual(added.json.sections[0].itemIds, ["show", "film"], "itemIds: the items alone");
  assert.deepEqual(added.json.home.map((h: Json) => h.itemId), ["show", "film"], "home: the items alone");
  assert.deepEqual(added.json.apps.map((a: Json) => [a.appId, a.onHome]), [[WEATHER, false], [NEWS, true], [RADIO, false]]);

  const steps: Array<[string, string, unknown, unknown[]]> = [
    ["POST", "/apps", { appId: WEATHER, sectionId: films }, [["untitled", ["i:show", `a:${NEWS}`, "i:film"]], [films, [`a:${WEATHER}`]]]],
    ["POST", "/items", { itemId: "news", sectionId: films, position: 0 }, [["untitled", ["i:show", `a:${NEWS}`, "i:film"]], [films, ["i:news", `a:${WEATHER}`]]]],
    ["POST", "/apps", { appId: RADIO, position: 99 }, [["untitled", ["i:show", `a:${NEWS}`, "i:film", `a:${RADIO}`]], [films, ["i:news", `a:${WEATHER}`]]]],
    ["PATCH", `/apps/${RADIO}`, { position: 0 }, [["untitled", [`a:${RADIO}`, "i:show", `a:${NEWS}`, "i:film"]], [films, ["i:news", `a:${WEATHER}`]]]],
    ["PATCH", "/items/film", { position: 1 }, [["untitled", [`a:${RADIO}`, "i:film", "i:show", `a:${NEWS}`]], [films, ["i:news", `a:${WEATHER}`]]]],
    ["PATCH", `/apps/${NEWS}`, { sectionId: films }, [["untitled", [`a:${RADIO}`, "i:film", "i:show"]], [films, ["i:news", `a:${WEATHER}`, `a:${NEWS}`]]]],
    ["PATCH", `/apps/${NEWS}`, { sectionId: films, position: 0 }, [["untitled", [`a:${RADIO}`, "i:film", "i:show"]], [films, [`a:${NEWS}`, "i:news", `a:${WEATHER}`]]]],
    ["DELETE", `/apps/${RADIO}`, undefined, [["untitled", ["i:film", "i:show"]], [films, [`a:${NEWS}`, "i:news", `a:${WEATHER}`]]]],
  ];
  for (const [i, [method, route, body, expected]] of steps.entries()) {
    const r = await home(method, route, body);
    assert.equal(r.status, 200, `${method} ${route}`);
    assert.deepEqual([r.json.version, cards(r.json.sections)], [v0 + 4 + i, expected], `${method} ${route}`);
  }
  const changed = (await s.admin("GET", `/events?after=${after}&types=home.changed`)).json.events.map((e: Json) => e.data);
  assert.deepEqual(changed.slice(2).map((d: Json) => [d.appIds, d.appsAdded, d.appsRemoved]), [
    [[NEWS], [NEWS], []], [[NEWS, WEATHER], [WEATHER], []], [[NEWS, WEATHER], [], []], [[NEWS, RADIO, WEATHER], [RADIO], []],
    [[RADIO, NEWS, WEATHER], [], []], [[RADIO, NEWS, WEATHER], [], []], [[RADIO, WEATHER, NEWS], [], []], [[RADIO, NEWS, WEATHER], [], []],
    [[NEWS, WEATHER], [], [RADIO]],
  ]);
  assert.deepEqual(changed[2].itemIds, ["show", "film"], "itemIds as before");
  assert.equal((await state()).version, v0 + 11);
  assert.deepEqual((await events("device.apps")).length, 1, "a Home change is no report");

  const refused: Array<[string, string, unknown, number, string]> = [
    ["POST", "/apps", { appId: WEATHER }, 400, "duplicate_app"],
    ["POST", "/apps", { appId: "com.example.unknown" }, 400, "unknown_app"],
    ["POST", "/apps", { appId: RADIO, sectionId: "nope1234" }, 404, "unknown_section"],
    ["POST", "/apps", { appId: "not an app" }, 400, "invalid_request"],
    ["POST", "/apps", { appId: RADIO, position: -1 }, 400, "invalid_request"],
    ["POST", "/apps", { itemId: "show" }, 400, "invalid_request"],
    ["PATCH", `/apps/${RADIO}`, { position: 0 }, 404, "not_on_home"],
    ["PATCH", `/apps/${NEWS}`, {}, 400, "invalid_request"],
    ["PATCH", `/apps/${NEWS}`, { sectionId: "nope1234" }, 404, "unknown_section"],
    ["PATCH", "/apps/not-an-app", { position: 0 }, 404, "not_on_home"],
    ["DELETE", `/apps/${RADIO}`, undefined, 404, "not_on_home"],
    ["DELETE", "/apps/show", undefined, 404, "not_on_home"],
    ["DELETE", "/items/com.example.news", undefined, 404, "not_on_home"],
  ];
  for (const [method, route, body, status, error] of refused) {
    const r = await home(method, route, body);
    assert.deepEqual([r.status, r.json.error], [status, error], `${method} ${route} ${JSON.stringify(body)}`);
  }
  assert.equal((await s.admin("POST", "/devices/ghost/home/apps", { appId: WEATHER })).json.error, "unknown_device");
  assert.equal((await state()).version, v0 + 11, "refusals bump nothing");

  // Up to 50 app cards besides the items; an app the TV no longer has stays on Home and can move.
  await report(Array.from({ length: 60 }, (_, i) => ({ appId: `com.example.a${i}`, label: `A${i}`, image: null })));
  for (let i = 0; i < HOME_MAX_APPS - 2; i++) assert.equal((await home("POST", "/apps", { appId: `com.example.a${i}` })).status, 200);
  const full = await home("POST", "/apps", { appId: "com.example.a59" });
  assert.deepEqual([full.status, full.json.error, full.json.max], [400, "too_many_apps", HOME_MAX_APPS]);
  assert.equal((await home("PATCH", `/apps/${NEWS}`, { position: 5 })).status, 200, "NEWS left the report and still moves");
  assert.equal((await home("DELETE", `/apps/${NEWS}`)).status, 200);
  assert.deepEqual([(await home("POST", "/apps", { appId: NEWS })).json.error], ["unknown_app"], "once off Home it needs the report again");
});

test("PUT …/home keeps app cards: at their place among the section's cards, clamped; a deleted section's to the untitled one; entries set both kinds", async (t) => {
  const { images, report, home, detail } = await setup(t);
  await report(three(images));
  const a = (await home("POST", "/sections", { title: "A" })).json.sectionId;
  await home("PUT", "", { itemIds: ["show", "film", "silent", "news"] });
  await home("POST", "/apps", { appId: WEATHER, position: 1 });
  await home("POST", "/apps", { appId: NEWS, position: 3 });
  await home("POST", "/apps", { appId: RADIO, sectionId: a });
  assert.deepEqual(cards((await detail()).sections), [["untitled", ["i:show", `a:${WEATHER}`, "i:film", `a:${NEWS}`, "i:silent", "i:news"]], [a, [`a:${RADIO}`]]]);

  let r = await home("PUT", "", { itemIds: ["news", "film"], expected: ["show", "film", "silent", "news"] });
  assert.deepEqual(cards(r.json.sections), [["untitled", ["i:news", `a:${WEATHER}`, "i:film", `a:${NEWS}`]], [a, [`a:${RADIO}`]]], "places kept, the last one clamped to the end");
  r = await home("PUT", "", { itemIds: [] });
  assert.deepEqual(cards(r.json.sections), [["untitled", [`a:${WEATHER}`, `a:${NEWS}`]], [a, [`a:${RADIO}`]]]);
  r = await home("PUT", "", { itemIds: ["show", "film", "silent"] });
  assert.deepEqual(cards(r.json.sections), [["untitled", [`a:${WEATHER}`, `a:${NEWS}`, "i:show", "i:film", "i:silent"]], [a, [`a:${RADIO}`]]]);

  // The sections form: itemIds keep the app cards; a section left out hands its app cards to the untitled one.
  r = await home("PUT", "", { sections: [{ id: "untitled", itemIds: ["film", "show"] }, { title: "B", itemIds: ["silent"] }] });
  const b = r.json.sections[1].id;
  assert.deepEqual(cards(r.json.sections), [["untitled", [`a:${WEATHER}`, `a:${NEWS}`, "i:film", "i:show", `a:${RADIO}`]], [b, ["i:silent"]]]);
  // entries: exactly those cards; an app card nobody lists leaves Home, one listed elsewhere moves.
  r = await home("PUT", "", {
    sections: [{ id: b, title: "B", entries: [{ appId: NEWS }, { itemId: "silent" }, { itemId: "news" }] }, { id: "untitled", itemIds: ["show"] }],
    expected: [{ id: "untitled", itemIds: ["film", "show"] }, { id: b, entries: [{ itemId: "silent" }] }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(cards(r.json.sections), [[b, [`a:${NEWS}`, "i:silent", "i:news"]], ["untitled", [`a:${WEATHER}`, "i:show", `a:${RADIO}`]]]);
  r = await home("PUT", "", { sections: [{ id: "untitled", entries: [{ itemId: "show" }, { appId: RADIO }] }] });
  assert.deepEqual(cards(r.json.sections), [["untitled", ["i:show", `a:${RADIO}`]]], "untitled given in entries: B's app card leaves with its items; WEATHER unlisted leaves");
  assert.deepEqual(r.json.apps.map((x: Json) => [x.appId, x.onHome]), [[WEATHER, false], [NEWS, false], [RADIO, true]]);

  const stale = await home("PUT", "", { sections: [{ id: "untitled", itemIds: [] }], expected: [{ id: "untitled", entries: [{ itemId: "show" }] }] });
  assert.deepEqual([stale.status, stale.json.error, cards(stale.json.sections)], [409, "home_changed", [["untitled", ["i:show", `a:${RADIO}`]]]], "expected compares entries");
  const sameItems = await home("PUT", "", { itemIds: ["show"], expected: ["show"] });
  assert.equal(sameItems.status, 200, "the itemIds form's expected names items alone");
  const refused: Array<[unknown, number, string]> = [
    [{ sections: [{ id: "untitled", entries: [{ appId: WEATHER }, { appId: WEATHER }] }] }, 400, "duplicate_app"],
    [{ sections: [{ id: "untitled", entries: [{ appId: "com.example.unknown" }] }] }, 400, "unknown_app"],
    [{ sections: [{ id: "untitled", entries: [{ itemId: "ghost" }] }] }, 400, "unknown_item"],
    [{ sections: [{ id: "untitled", entries: [{ itemId: "show", appId: WEATHER }] }] }, 400, "invalid_request"],
    [{ sections: [{ id: "untitled", entries: [{}] }] }, 400, "invalid_request"],
    [{ sections: [{ id: "untitled", itemIds: [], entries: [] }] }, 400, "invalid_request"],
    [{ sections: [{ id: "untitled" }] }, 400, "invalid_request"],
    [{ sections: [{ id: "untitled", entries: [{ appId: "nope" }] }] }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of refused) {
    const res = await home("PUT", "", body);
    assert.deepEqual([res.status, res.json.error], [status, error], JSON.stringify(body));
  }

  // Deleting a section moves its app cards with its items, in their order, to the end of the untitled section.
  const c = (await home("POST", "/sections", { title: "C" })).json.sectionId;
  await home("POST", "/apps", { appId: WEATHER, sectionId: c });
  await home("POST", "/items", { itemId: "film", sectionId: c });
  await home("PATCH", `/apps/${RADIO}`, { sectionId: c, position: 1 });
  r = await home("DELETE", `/sections/${c}`);
  assert.deepEqual(cards(r.json.sections), [["untitled", ["i:show", `a:${WEATHER}`, `a:${RADIO}`, "i:film"]]]);
});

test("the TV's state: entries in every section, app cards whether or not the TV still has the app; a section of app cards alone is listed", async (t) => {
  const { s, images, report, home, state } = await setup(t);
  await report(three(images));
  const apps = (await home("POST", "/sections", { title: "Apps", layout: "row" })).json.sectionId;
  await home("PUT", "", { itemIds: ["show", "film"] });
  await home("POST", "/apps", { appId: WEATHER, position: 1 });
  await home("POST", "/apps", { appId: NEWS, sectionId: apps });
  await home("POST", "/apps", { appId: RADIO, sectionId: apps });
  await report([three(images)[0]!]);

  const st = await state();
  assert.deepEqual(st.home.map((h: Json) => h.item.id), ["show", "film"], "home has the items alone");
  assert.deepEqual(st.homeSections, [
    { id: "untitled", title: null, layout: "grid", itemIds: ["show", "film"], entries: [{ itemId: "show" }, { appId: WEATHER }, { itemId: "film" }] },
    { id: apps, title: "Apps", layout: "row", itemIds: [], entries: [{ appId: NEWS }, { appId: RADIO }] },
  ]);

  // A catalog reload takes "film" away: it leaves entries and itemIds alike; the app cards stay, also in another catalog.
  await writeBundle(s.bundleDir, { ...fixtureManifest(), buildId: "fixture-2" }, { items: fixtureItems().items.filter((i: Json) => i.id !== "film") });
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  assert.deepEqual((await state()).homeSections.map((x: Json) => [x.itemIds, x.entries.length]), [[["show"], 2], [[], 2]]);
  await writeBundle(s.bundleDir, { ...fixtureManifest(), catalogId: "other", buildId: "other-1" }, fixtureItems());
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  const other = await state();
  assert.deepEqual([other.home, other.homeSections.map((x: Json) => [x.id, x.itemIds, x.entries])], [[], [
    ["untitled", [], [{ appId: WEATHER }]], [apps, [], [{ appId: NEWS }, { appId: RADIO }]],
  ]], "switching catalogs keeps the app cards");
});

test("the admin page's apps: the report's in its order, then the app cards it no longer names (their last label and picture)", async (t) => {
  const { s, tv, images, report, upload, home, detail } = await setup(t);
  await report(three(images));
  await upload(sha(images.news), images.news);
  await home("POST", "/apps", { appId: NEWS });
  await home("POST", "/apps", { appId: RADIO });
  await report([{ appId: "tv.example.Games", label: "Games", image: null }, { appId: RADIO, label: "Radio 2", image: null }]);
  const d = await detail();
  assert.deepEqual(d.apps, [
    { appId: "tv.example.Games", label: "Games", imageUrl: null, installed: true, onHome: false },
    { appId: RADIO, label: "Radio 2", imageUrl: null, installed: true, onHome: true },
    { appId: NEWS, label: "News", imageUrl: `/app-images/${sha(images.news)}.png`, installed: false, onHome: true },
  ]);
  assert.deepEqual(cards(d.sections), [["untitled", [`a:${NEWS}`, `a:${RADIO}`]]]);
  assert.equal((await s.admin("GET", "/devices")).json.devices[0].homeCount, 0, "homeCount counts the items");

  // Replacing the TV keeps its Home and its app cards.
  const start = await s.call("POST", "/api/v1/pair/start");
  await s.admin("POST", "/pair/approve", { code: start.json.code, replaces: tv.deviceId });
  const done = await s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken });
  assert.equal(done.json.deviceId, tv.deviceId);
  const st = (await s.call("GET", "/api/v1/tv/state", { token: done.json.deviceToken })).json;
  assert.deepEqual(st.homeSections[0].entries, [{ appId: NEWS }, { appId: RADIO }]);
});

test("the migration to app cards keeps a Home: its entries become item cards, in order, with their dates; the kinds stay apart", async () => {
  const file = path.join(await tempDir(), "izle.db");
  const old = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  const before = MIGRATIONS.length - 1;
  for (let v = 0; v < before; v++) old.exec(`${MIGRATIONS[v]!}; PRAGMA user_version = ${v + 1}`);
  old.exec(`
    INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'Salon', 'h', 1);
    INSERT INTO home_sections (device_id, section_id, position, title, layout) VALUES ('d1', 'Abc12345', 0, 'Kids', 'row'), ('d1', 'untitled', 1, NULL, 'grid');
    INSERT INTO home_entries (device_id, position, catalog_id, item_id, added_at, section_id)
      VALUES ('d1', 0, 'c', 'a', 10, 'Abc12345'), ('d1', 1, 'c', 'b', 11, 'untitled'), ('d1', 2, 'other', 'z', 12, 'untitled');
  `);
  old.close();

  const s = new Store(file);
  assert.equal(s.schemaVersion, MIGRATIONS.length);
  assert.deepEqual(s.getHomeEntries("d1", "c"), [{ itemId: "a", addedAt: 10, sectionId: "Abc12345" }, { itemId: "b", addedAt: 11, sectionId: "untitled" }]);
  assert.deepEqual(s.getHomeEntries("d1", "other"), [{ itemId: "z", addedAt: 12, sectionId: "untitled" }]);
  assert.deepEqual([s.getDevice("d1")?.appsReportedAt, s.getDeviceApps("d1")], [null, []]);

  // App cards are in every catalog's Home, after the items' kind check.
  s.setDeviceApps("d1", [{ appId: WEATHER, label: "Weather", image: "a".repeat(64) }], 20);
  s.setHome("d1", "c", [section("untitled", null, "grid", ["b"]), { id: "Abc12345", title: "Kids", layout: "row", entries: [{ appId: WEATHER }, { itemId: "a" }] }], 30);
  assert.deepEqual(s.getHomeCards("d1", "elsewhere").map((c) => [c.itemId, c.appId, c.appLabel, c.appImage, c.addedAt]), [[null, WEATHER, "Weather", "a".repeat(64), 30]]);
  s.close();
  const check = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  for (const values of ["'d1', 9, 'c', 'q', 'com.x.y'", "'d1', 9, NULL, NULL, NULL", "'d1', 9, NULL, 'q', NULL", "'d1', 9, 'c', NULL, 'com.x.y'"]) {
    assert.throws(() => check.exec(`INSERT INTO home_entries (device_id, position, catalog_id, item_id, app_id, added_at, section_id) VALUES (${values}, 1, 'untitled')`), /CHECK/, values);
  }
  assert.throws(() => check.exec("INSERT INTO home_entries (device_id, position, app_id, added_at, section_id) VALUES ('d1', 9, 'com.x.y', 1, 'gone0000')"), /FOREIGN KEY/);
  check.exec("DELETE FROM devices WHERE id = 'd1'");
  assert.deepEqual(["home_entries", "device_apps"].map((t) => check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n), [0, 0], "they go with the TV");
  check.close();
});
