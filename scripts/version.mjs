#!/usr/bin/env node
// @ts-check
// One version for everything that is released: the contract and server packages and the Android app.
//
//   node scripts/version.mjs check [--tag v1.2.3]   all versions agree (and match the tag); exit 1 otherwise
//   node scripts/version.mjs set 1.2.3              writes the version everywhere (package.json files and the
//                                                   server's dependency on the contract, the lockfile's
//                                                   workspace entries, android versionName)
//
// The Android versionCode is derived from versionName in android/app/build.gradle.kts.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GRADLE = path.join(ROOT, "android", "app", "build.gradle.kts");
const LOCK = path.join(ROOT, "package-lock.json");
const WORKSPACES = ["contract", "server"];
const VERSION_NAME = /^(\s*versionName\s*=\s*")([^"]*)(")/m;
// Major.minor.patch, each < 100 except major, so versionCode = major * 10000 + minor * 100 + patch grows with it.
const SEMVER = /^(0|[1-9]\d*)\.([1-9]?\d)\.([1-9]?\d)(-[0-9A-Za-z.-]+)?$/;

const pkgFile = (/** @type {string} */ ws) => path.join(ROOT, ws, "package.json");
const readJson = async (/** @type {string} */ file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = (/** @type {string} */ file, /** @type {unknown} */ value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const [command, ...rest] = process.argv.slice(2);
if (command === "check") {
  const { values } = parseArgs({ args: rest, options: { tag: { type: "string" } } });
  const lock = await readJson(LOCK);
  const found = [];
  for (const ws of WORKSPACES) found.push({ where: `${ws}/package.json`, version: (await readJson(pkgFile(ws))).version });
  for (const ws of WORKSPACES) found.push({ where: `package-lock.json (${ws})`, version: lock.packages[ws]?.version });
  const m = VERSION_NAME.exec(await readFile(GRADLE, "utf8"));
  found.push({ where: "android/app/build.gradle.kts versionName", version: m ? m[2] : "(not found)" });

  const expected = values.tag ? values.tag.replace(/^v/, "") : found[0].version;
  const wrong = found.filter((f) => f.version !== expected);
  if (!SEMVER.test(expected)) wrong.unshift({ where: `"${expected}" is not a version like 1.2.3 (minor and patch < 100)`, version: "" });
  if (wrong.length > 0) {
    process.stderr.write(`version mismatch, expected ${expected}${values.tag ? ` (tag ${values.tag})` : ""}:\n`);
    for (const w of wrong) process.stderr.write(`  ${w.where}${w.version ? `: ${w.version}` : ""}\n`);
    process.exit(1);
  }
  process.stdout.write(`${expected}\n`);
} else if (command === "set" && rest.length === 1 && SEMVER.test(rest[0])) {
  const version = rest[0];
  /** Sets the version and keeps dependencies on sibling workspaces (`@izle/*`) in range (`^0.1.0` excludes 0.2.0). */
  const update = (/** @type {any} */ pkg) => {
    pkg.version = version;
    for (const name of Object.keys(pkg.dependencies ?? {})) if (name.startsWith("@izle/")) pkg.dependencies[name] = `^${version}`;
  };
  for (const ws of WORKSPACES) {
    const pkg = await readJson(pkgFile(ws));
    update(pkg);
    await writeJson(pkgFile(ws), pkg);
  }
  const lock = await readJson(LOCK);
  for (const ws of WORKSPACES) update(lock.packages[ws]);
  await writeJson(LOCK, lock);
  const gradle = await readFile(GRADLE, "utf8");
  if (!VERSION_NAME.test(gradle)) throw new Error(`no versionName in ${GRADLE}`);
  await writeFile(GRADLE, gradle.replace(VERSION_NAME, `$1${version}$3`));
  process.stdout.write(`set ${version} in ${WORKSPACES.map((w) => `${w}/package.json`).join(", ")}, package-lock.json and the Android versionName\n`);
} else {
  process.stderr.write("usage: node scripts/version.mjs check [--tag vX.Y.Z] | set X.Y.Z\n");
  process.exit(2);
}
