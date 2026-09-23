import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCardBinding } from "./card-binding.ts";
import { loadBoardBinding } from "./board/binding.ts";
import { loadInboxBinding } from "./inbox/binding.ts";
import { loadUsageBinding } from "./usage/binding.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-card-binding-"));
}

/** What one load of a malformed binding file logs, through the loader handed in. */
function malformedLines(
  load: (file: string, options: { log: (message: string) => void }) => unknown,
): string[] {
  const directory = scratch();
  try {
    const file = path.join(directory, "card.json");
    writeFileSync(file, "{not json", "utf8");
    const said: string[] = [];
    load(file, { log: (message) => said.push(message) });
    return said;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the shared binding's log lines carry the label it was given", () => {
  // The whole phrase is matched rather than the bare label, because each line also carries the
  // file's path, and a host's temp directory could hold either label as a word.
  const alphaSaid = malformedLines((file, options) => loadCardBinding(file, "alpha", options));
  assert.equal(alphaSaid.length, 1);
  assert.match(alphaSaid[0], /the alpha card binding/);
  assert.doesNotMatch(alphaSaid[0], /the beta card binding/);

  const betaSaid = malformedLines((file, options) => loadCardBinding(file, "beta", options));
  assert.equal(betaSaid.length, 1);
  assert.match(betaSaid[0], /the beta card binding/);
  assert.doesNotMatch(betaSaid[0], /the alpha card binding/);
});

// Each card hands the shared module its own label, and an operator greps for the phrase it makes,
// so each card's label is pinned through that card's own loader.
for (const [card, load] of [
  ["board", loadBoardBinding],
  ["usage", loadUsageBinding],
  ["inbox", loadInboxBinding],
] as const) {
  test(`the ${card} card's binding logs as "the ${card} card binding"`, () => {
    const said = malformedLines(load);
    assert.equal(said.length, 1);
    assert.match(said[0], new RegExp(`the ${card} card binding`));
  });
}
