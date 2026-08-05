// Verifies the test harness itself runs: a runner that reports green because it found no
// files would be indistinguishable from one that actually executed an assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package.json parses and declares an ESM package", () => {
  const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(raw);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.name, "sapplefeld-channels");
});
