import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { namesOneDirectory, namesOneLocalDirectory } from "../config.ts";
import {
  MAX_ROSTER_FILE_BYTES,
  MAX_ROSTER_PERSONA_NAME_LENGTH,
  MAX_ROSTER_PERSONAS,
  createRosterReader,
} from "./roster.ts";

/** One scratch roster file per test, so no two tests share a path or a directory. */
function rosterFile(): { file: string; write: (text: string) => void; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-roster-"));
  const file = path.join(dir, "fleet.json");
  return {
    file,
    write: (text: string) => writeFileSync(file, text, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "worker", workdir: "D:\\personas\\worker", enabled: true, ...overrides };
}

test("five enabled entries yield five personas in file order", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  const entries = ["a", "b", "c", "d", "e"].map((name) =>
    entry({ name, workdir: `D:\\personas\\${name}` }),
  );
  roster.write(JSON.stringify(entries));

  const personas = createRosterReader(roster.file).read();
  assert.deepEqual(
    personas,
    entries.map((e) => ({ name: e.name, workdir: e.workdir })),
  );
});

test("an entry with enabled false or enabled absent yields no persona", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(
    JSON.stringify([
      entry({ name: "off", enabled: false }),
      entry({ name: "unset", enabled: undefined }),
    ]),
  );

  assert.deepEqual(createRosterReader(roster.file).read(), []);
});

// A refusal check: JSON's own boolean is the only value the `enabled` rule accepts, so a truthy
// non-boolean is refused by the same `record.enabled !== true` comparison that refuses `false` and
// absence above, not by a separate rule.
test("a truthy but non-boolean enabled value is refused, not treated as on", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(
    JSON.stringify([
      entry({ name: "string-true", enabled: "true" }),
      entry({ name: "number-one", enabled: 1 }),
    ]),
  );

  assert.deepEqual(createRosterReader(roster.file).read(), []);
});

test("a workdir that is not rooted on a drive yields no persona and does not throw", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  // The first two are relative in every reading. The rooted, drive-less pair are the withheld
  // members: `path.isAbsolute` accepts them on Windows, where they resolve against whichever drive
  // the broker was launched from, and only the guard's own drive-letter rule refuses them.
  const unrootedWorkdirs = ["relative\\path", "personas/worker", "\\personas\\worker", "/personas/worker"];

  for (const unrootedWorkdir of unrootedWorkdirs) {
    // Control: the guard the roster reader applies refuses each on its own, and accepts the drive
    // rooted form the rest of this file writes, so a guard reduced to `path.isAbsolute` turns this red.
    assert.equal(namesOneLocalDirectory(unrootedWorkdir), false, `the guard refuses ${unrootedWorkdir}`);
    roster.write(JSON.stringify([entry({ workdir: unrootedWorkdir })]));

    assert.deepEqual(createRosterReader(roster.file).read(), [], `no persona for ${unrootedWorkdir}`);
  }
  assert.equal(namesOneLocalDirectory("D:\\personas\\worker"), true);
});

test("a missing name yields no persona and does not throw", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  const { name, ...rest } = entry();
  roster.write(JSON.stringify([rest]));

  assert.deepEqual(createRosterReader(roster.file).read(), []);
});

test("a repeated name keeps the first entry and drops the later one", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(
    JSON.stringify([
      entry({ name: "dup", workdir: "D:\\personas\\first" }),
      entry({ name: "dup", workdir: "D:\\personas\\second" }),
    ]),
  );

  assert.deepEqual(createRosterReader(roster.file).read(), [
    { name: "dup", workdir: "D:\\personas\\first" },
  ]);
});

test("a non-array file yields no persona, clearing rather than holding a prior good read", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "held" })]));

  const reader = createRosterReader(roster.file);
  const first = reader.read();
  assert.deepEqual(first, [{ name: "held", workdir: "D:\\personas\\worker" }]);

  roster.write(JSON.stringify({ not: "an array" }));
  assert.deepEqual(reader.read(), [], "a non-array file is an operator typo, not a torn write");
});

test("a roster that parsed last tick and does not parse this tick yields last tick's personas", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "steady" })]));

  const reader = createRosterReader(roster.file);
  const first = reader.read();
  assert.deepEqual(first, [{ name: "steady", workdir: "D:\\personas\\worker" }]);

  // A write caught mid-save: truncated JSON, exactly the shape an operator's editor or script can
  // leave on disk for the instant between opening the file for write and finishing it.
  roster.write('[{"name": "steady", "workdir": "D:\\\\personas\\\\worker", "enabled": tr');
  assert.deepEqual(reader.read(), first, "the held reading survives a torn write");
});

test("an unreadable file yields the held reading rather than throwing", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "held" })]));

  const reader = createRosterReader(roster.file);
  const first = reader.read();

  // The file is removed entirely, which is what "unreadable" covers alongside a permission refusal.
  roster.cleanup();
  assert.deepEqual(reader.read(), first);
});

test("a file over the byte cap yields the held reading rather than throwing", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "held" })]));

  const reader = createRosterReader(roster.file);
  const first = reader.read();

  // The padding entry is itself an enabled, distinct persona, so an unenforced cap would return
  // `first` plus this one: the assertion below only speaks because the two lists actually differ.
  const padding = "x".repeat(MAX_ROSTER_FILE_BYTES + 1);
  roster.write(
    JSON.stringify([
      entry({ name: "held" }),
      entry({ name: "second", workdir: "D:\\personas\\second" }),
      { padding },
    ]),
  );
  assert.deepEqual(reader.read(), first);
});

test("more than the cap keeps the first personas in file order and logs the drop once per change", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  const entries = Array.from({ length: MAX_ROSTER_PERSONAS + 3 }, (_, i) =>
    entry({ name: `worker-${String(i)}`, workdir: `D:\\personas\\worker-${String(i)}` }),
  );
  roster.write(JSON.stringify(entries));

  const lines: string[] = [];
  const reader = createRosterReader(roster.file, { log: (message) => lines.push(message) });

  const personas = reader.read();
  assert.equal(personas.length, MAX_ROSTER_PERSONAS);
  assert.deepEqual(
    personas.map((p) => p.name),
    entries.slice(0, MAX_ROSTER_PERSONAS).map((e) => e.name),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /dropped 3 persona\(s\)/);
  for (const line of lines) assert.doesNotMatch(line, /personas[\\/]worker/);

  // The same drop count on the next tick is not logged again.
  reader.read();
  assert.equal(lines.length, 1, "an unchanged dropped count is not logged twice");

  // Falling back under the cap updates the held count without logging: only a non-zero drop is
  // worth a line, so the return to zero is silent.
  roster.write(JSON.stringify(entries.slice(0, MAX_ROSTER_PERSONAS)));
  reader.read();
  assert.equal(lines.length, 1, "returning to zero dropped is not itself logged");
});

test("an unreadable roster logs the failure once per change, and no logged line is path-shaped", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "held", workdir: "D:\\personas\\c\\worker" })]));

  const lines: string[] = [];
  const reader = createRosterReader(roster.file, { log: (message) => lines.push(message) });
  reader.read();

  // The whole scratch directory is removed, so the file is unreadable on every later tick.
  roster.cleanup();
  reader.read();
  reader.read();
  assert.equal(lines.length, 1, "the same failure class is not logged again while it persists");
  assert.match(lines[0], /unreadable/);

  // An absence check over the class rather than over this fixture's own literal: no logged line may
  // contain a path separator, since a workdir or a roster path always carries one of the two slash
  // spellings on this platform, whatever value an operator names.
  for (const line of lines) {
    assert.ok(!/[\\/]/.test(line), `a logged line must never be path-shaped: ${line}`);
  }
});

test("a parse failure and a non-array file are each logged once per change, distinct from unreadable", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(JSON.stringify([entry({ name: "held" })]));

  const lines: string[] = [];
  const reader = createRosterReader(roster.file, { log: (message) => lines.push(message) });
  reader.read();

  roster.write('[{"name": "held", "workdir": "D:\\\\personas\\\\worker", "enabled": tr');
  reader.read();
  reader.read();
  assert.equal(lines.length, 1, "the parse failure logs once, not every tick");
  assert.match(lines[0], /unparseable/);

  roster.write(JSON.stringify({ not: "an array" }));
  reader.read();
  assert.equal(lines.length, 2, "the change from unparseable to not-an-array logs again");
  assert.match(lines[1], /not an array/);

  // Recovery logs nothing, and a later recurrence of the same class logs once more.
  roster.write(JSON.stringify([entry({ name: "held" })]));
  reader.read();
  assert.equal(lines.length, 2, "returning to a good read is not itself logged");
  roster.write(JSON.stringify({ not: "an array" }));
  reader.read();
  assert.equal(lines.length, 3, "a failure class recurring after recovery is logged again");
});

test("a name is trimmed before the non-empty check, and a name past the cap yields no persona", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  roster.write(
    JSON.stringify([
      entry({ name: "   ", workdir: "D:\\personas\\blank" }),
      entry({ name: "  padded  ", workdir: "D:\\personas\\padded" }),
      entry({
        name: "x".repeat(MAX_ROSTER_PERSONA_NAME_LENGTH + 1),
        workdir: "D:\\personas\\long",
      }),
    ]),
  );

  assert.deepEqual(createRosterReader(roster.file).read(), [
    { name: "padded", workdir: "D:\\personas\\padded" },
  ]);
});

test("a UNC workdir is refused by the roster's narrower local-only rule, not by the general absolute-path rule", (t) => {
  const roster = rosterFile();
  t.after(roster.cleanup);
  // Windows resolves any two leading separators as a share root, whatever the two spellings mix to,
  // so the refusal is checked over that whole class rather than over the two homogeneous forms the
  // guard's own pattern most obviously names. The mixed pair below are the withheld members: they
  // are matched on the class's shape, not on a literal the guard was written against.
  const uncWorkdirs = [
    "\\\\host\\share\\workdir",
    "//host/share/workdir",
    "/\\host\\share\\workdir",
    "\\/host/share/workdir",
  ];

  for (const uncWorkdir of uncWorkdirs) {
    // Control: the general rule a configured project root and the events path are held to accepts a
    // UNC root outright. If the roster refused this value too, the assertion below would prove
    // nothing about namesOneLocalDirectory specifically, since the general rule would have caught it
    // first.
    assert.equal(namesOneDirectory(uncWorkdir), true, `the general rule accepts ${uncWorkdir}`);
    assert.equal(
      namesOneLocalDirectory(uncWorkdir),
      false,
      `the roster's narrower rule must refuse ${uncWorkdir}`,
    );

    roster.write(JSON.stringify([entry({ name: "unc", workdir: uncWorkdir })]));
    assert.deepEqual(
      createRosterReader(roster.file).read(),
      [],
      `namesOneLocalDirectory must refuse ${uncWorkdir}`,
    );
  }
});
