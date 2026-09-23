import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCardBinding } from "./card-binding.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-card-binding-"));
}

test("the shared binding's log lines carry the label it was given", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "card.json");
    writeFileSync(file, "{not json", "utf8");

    const alphaSaid: string[] = [];
    loadCardBinding(file, "alpha", { log: (m) => alphaSaid.push(m) });
    assert.equal(alphaSaid.length, 1);
    assert.match(alphaSaid[0], /the alpha card binding/);
    assert.doesNotMatch(alphaSaid[0], /\bbeta\b/);

    const betaSaid: string[] = [];
    loadCardBinding(file, "beta", { log: (m) => betaSaid.push(m) });
    assert.equal(betaSaid.length, 1);
    assert.match(betaSaid[0], /the beta card binding/);
    assert.doesNotMatch(betaSaid[0], /\balpha\b/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
