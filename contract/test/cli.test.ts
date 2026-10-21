import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeBundle } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/izle-validate.js", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../sample-catalog", import.meta.url));

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("izle-validate exits 0 with a summary for a valid bundle, or JSON with --json", async () => {
  const r = await run([SAMPLE]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✔ .*valid izle-bundle v1/);
  const json = await run([SAMPLE, "--json"]);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).ok, true);
});

test("izle-validate counts items by kind, live channels included", async () => {
  const dir = await makeBundle();
  const r = await run([dir]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 items \(1 movies, 1 series, 1 live\), 3 episodes \(2 playable\), 3 sources/);
  const json = await run([dir, "--json"]);
  assert.equal(JSON.parse(json.stdout).stats.live, 1);
});

test("izle-validate exits 1 and lists errors for an invalid bundle", async () => {
  const dir = await makeBundle({ items: (i) => (i.items[1].id = "movie-a") });
  const r = await run([dir]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✖ items.json \/items\/1\/id: duplicate item id "movie-a"/);
});

test("izle-validate exits 2 on usage errors", async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["a", "b"])).code, 2);
  assert.equal((await run(["--bogus", SAMPLE])).code, 2);
});
