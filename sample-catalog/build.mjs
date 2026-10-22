#!/usr/bin/env node
// (Re)builds the sample catalog's posters and manifest metadata.
//
//   node sample-catalog/build.mjs                  download posters, re-encode, update items.json + bundle.json
//   node sample-catalog/build.mjs --manifest-only  only refresh buildId/builtAt in bundle.json
//
// Posters are downloaded from the sources listed in POSTERS (all CC BY or public domain, see NOTICE.md),
// re-encoded by ImageMagick (`magick` must be on PATH) to 400×600 JPEG ≤ 200 KB, and stored content-addressed
// as assets/<sha256>.jpg. Afterwards run `npx izle-validate sample-catalog`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(DIR, "assets");
const MAX_BYTES = 200 * 1024;
const UA = "izle-sample-build/1 (+https://github.com/mickeiik/izle)";

/**
 * The source is scaled to cover 400×600 and cropped to 2:3. `focusX` (0–1, default 0.5) is the horizontal
 * centre of the crop, for landscape stills whose subject is not in the middle.
 */
const POSTERS = {
  caminandes: { url: "https://upload.wikimedia.org/wikipedia/commons/1/14/Caminandes_gran_dillama.png", focusX: 0.45 },
  "tears-of-steel": { url: "https://upload.wikimedia.org/wikipedia/commons/7/70/Tos-poster.png" },
  "big-buck-bunny": { url: "https://upload.wikimedia.org/wikipedia/commons/c/c5/Big_buck_bunny_poster_big.jpg" },
  sintel: { url: "https://upload.wikimedia.org/wikipedia/commons/8/8f/Sintel_poster.jpg" },
  "elephants-dream": { url: "https://upload.wikimedia.org/wikipedia/commons/e/e8/Elephants_Dream_s5_both.jpg", focusX: 0.55 },
  "his-girl-friday": { url: "https://upload.wikimedia.org/wikipedia/commons/6/6e/His_Girl_Friday_%281940_poster%29.jpg" },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
const writeJson = (file, value) => writeFileSync(path.join(DIR, file), `${toJson(value)}\n`);

/** JSON indented by two; scalar arrays and objects of those stay on one line when it fits in 120 columns. */
function toJson(value, indent = "", column = 0) {
  const scalar = (v) => typeof v !== "object" || v === null;
  const leaf = (v) => scalar(v) || (Array.isArray(v) && v.every(scalar));
  const entries = (o) => Object.entries(o).map(([k, v]) => [JSON.stringify(k), v]);
  const oneLine = (v) => {
    if (scalar(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(oneLine).join(", ")}]`;
    return Object.keys(v).length ? `{ ${entries(v).map(([k, x]) => `${k}: ${oneLine(x)}`).join(", ")} }` : "{}";
  };
  if (scalar(value)) return JSON.stringify(value);
  const flat = leaf(value) || (!Array.isArray(value) && Object.values(value).every(leaf));
  if (flat && column + oneLine(value).length < 120) return oneLine(value);
  const inner = `${indent}  `;
  const lines = Array.isArray(value)
    ? value.map((v) => toJson(v, inner, inner.length))
    : entries(value).map(([k, v]) => `${k}: ${toJson(v, inner, inner.length + k.length + 2)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${inner}${lines.join(`,\n${inner}`)}\n${indent}${close}`;
}

/** The poster as a 400×600 JPEG; `image` is the downloaded file's bytes. */
function encode(image, focusX, quality) {
  const magick = (args, opts) => execFileSync("magick", args, { input: image, maxBuffer: 16 * 1024 * 1024, ...opts });
  const [w, h] = magick(["identify", "-format", "%w %h", "-[0]"], { encoding: "utf8" }).split(" ").map(Number);
  const scale = Math.max(400 / w, 600 / h);
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);
  const x = Math.min(Math.max(Math.round(sw * focusX - 200), 0), sw - 400);
  const y = Math.max(Math.round((sh - 600) / 2), 0);
  return magick([
    "-[0]", "-resize", `${sw}x${sh}!`, "-crop", `400x600+${x}+${y}`, "+repage",
    "-strip", "-interlace", "Plane", "-sampling-factor", "4:2:0", "-quality", String(quality), "jpg:-",
  ]);
}

async function buildPosters(items) {
  for (const item of items) {
    const spec = POSTERS[item.id];
    if (!spec) {
      item.poster = null;
      continue;
    }
    const res = await fetch(spec.url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`${item.id}: poster download failed with HTTP ${res.status}`);
    const image = Buffer.from(await res.arrayBuffer());
    let quality = 85;
    let jpg = encode(image, spec.focusX ?? 0.5, quality);
    while (jpg.length > MAX_BYTES && quality > 40) jpg = encode(image, spec.focusX ?? 0.5, (quality -= 5));
    const name = `${sha256(jpg)}.jpg`;
    writeFileSync(path.join(ASSETS, name), jpg);
    item.poster = `assets/${name}`;
    console.log(`${item.id}: ${name} (${Math.round(jpg.length / 1024)} KB, q${quality})`);
  }

  const referenced = new Set(items.flatMap((i) => [i.poster, i.backdrop]).filter(Boolean));
  for (const f of readdirSync(ASSETS)) {
    if (!f.startsWith(".") && !referenced.has(`assets/${f}`)) {
      unlinkSync(path.join(ASSETS, f));
      console.log(`removed stale asset ${f}`);
    }
  }
}

const manifestOnly = process.argv.includes("--manifest-only");
const itemsFile = readJson("items.json");
if (!manifestOnly) {
  await buildPosters(itemsFile.items);
  writeJson("items.json", itemsFile);
}

const manifest = readJson("bundle.json");
const now = new Date();
const itemsHash = sha256(readFileSync(path.join(DIR, "items.json"))).slice(0, 8);
manifest.buildId = `${now.toISOString().slice(0, 10).replaceAll("-", "")}-${itemsHash}`;
manifest.builtAt = `${now.toISOString().slice(0, 19)}Z`;
writeJson("bundle.json", manifest);
console.log(`bundle.json: buildId ${manifest.buildId}`);
