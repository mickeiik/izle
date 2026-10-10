import { test } from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION } from "../src/index.ts";

test("exports the bundle format identifiers", () => {
  assert.equal(BUNDLE_FORMAT, "izle-bundle");
  assert.equal(BUNDLE_FORMAT_VERSION, 1);
});
