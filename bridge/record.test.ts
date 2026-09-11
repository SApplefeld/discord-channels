// The record file: driven against files this test builds in a temp directory, never against a real
// session's own record, exactly as `log.test.ts` drives the session-log reader against fixtures it
// builds rather than against the operator's harness home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_META_REASON } from "./protocol.ts";
import { MAX_PENDING_TURNS, RecordWriter, formatSection, leadingHeader, rotateRecord } from "./record.ts";

/** A temp directory of this test's own, removed when the test ends. */
function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clock this test controls, so a section's timestamp is a value the assertions can name. */
function clock(iso: string): () => string {
  return () => iso;
}

/** The file's content, or undefined for one that is not there. */
function content(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

test("formatSection carries the text verbatim, and only the header and the NEXT line are the writer's own words", () => {
  const section = formatSection("Reviewer", "DeepSeekHarness", "build the thing\nwith two lines", "2026-01-01T00:00:00.000Z");

  assert.equal(section, "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nwith two lines\nNEXT: DeepSeekHarness\n");
  assert.ok(section.startsWith("## Reviewer @ "), "the header names who spoke and when");
  assert.ok(section.endsWith("NEXT: DeepSeekHarness\n"), "the section ends naming who speaks next");
});

test("leadingHeader is everything before the first section, and the whole file when there is no section yet", () => {
  assert.equal(leadingHeader("# Notes\nan operator's own header\n\n## Reviewer @ x\nhi\nNEXT: DeepSeekHarness\n"), "# Notes\nan operator's own header\n\n");
  assert.equal(leadingHeader(""), "", "an empty file has an empty header");
  assert.equal(leadingHeader("nothing but prose, no section at all"), "nothing but prose, no section at all", "no `## ` line means the whole file is header");
  // The control: a line that merely contains `## ` past its own start does not open the match, since
  // only a line beginning with it is a section.
  assert.equal(leadingHeader("see the ## note above\n## Reviewer @ x\nhi\nNEXT: y\n"), "see the ## note above\n");
});

test("an append creates the record's parent directory when it is not there yet", (t) => {
  // A `record` argument naming a path under a directory nobody has created yet is a plausible,
  // ordinary caller mistake (a workspace laid out the record's directory has not been made in yet),
  // and it must not turn the whole prompt into a failure a caller cannot recover from without first
  // creating that directory by hand.
  const dir = workspace(t);
  const record = path.join(dir, "nested", "deeper", "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.appendParty(token, "build the thing");

  assert.equal(content(record), "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nNEXT: DeepSeekHarness\n");
});

test("the party's section is appended once the runtime has accepted the prompt, and the counterparty's at the turn's end, in order and never altering what came before", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const token1 = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.appendParty(token1, "build the thing");
  const afterParty = content(record);
  assert.equal(afterParty, "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nNEXT: DeepSeekHarness\n");

  writer.noteTurnEnd("builder", "done, it builds", clock("2026-01-01T00:05:00.000Z"), "turn_end", "completed", true);
  const afterCounterparty = content(record);
  assert.ok(afterCounterparty?.startsWith(afterParty ?? ""), "the party's section is an unaltered prefix of the finished record");
  assert.equal(
    afterCounterparty,
    `${afterParty}\n## DeepSeekHarness @ 2026-01-01T00:05:00.000Z\ndone, it builds\nNEXT: Reviewer\n`,
  );

  // A second turn for the same name, registered only after the first has fully ended, appends after
  // it, never rewriting it.
  const token2 = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:10:00.000Z"));
  assert.notEqual(token2, undefined, "the name is free once its first turn has ended");
  writer.appendParty(token2, "now add a test");
  writer.noteTurnEnd("builder", "added", clock("2026-01-01T00:11:00.000Z"), "turn_end", "completed", true);
  const final = content(record);
  assert.ok(final?.startsWith(afterCounterparty ?? ""), "the first turn's two sections are an unaltered prefix of the whole record");
  assert.equal(final?.match(/^## /gm)?.length, 4, "four sections in all, one per party per turn");
});

test("a counterparty section asked for before its own party section has landed is held, then flushed in order once it has", (t) => {
  // The turn-end listener can run from inside a still-pending prompt request, per `Bridge`'s own
  // `onTurnEnd` contract, so the counterparty append can be asked for before the dispatch that
  // appends the party section has even run. Nothing is written out of order for it.
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.noteTurnEnd("builder", "done already", clock("2026-01-01T00:00:05.000Z"), "turn_end", "completed", true);
  assert.equal(content(record), undefined, "nothing is written while the party section it must follow has not landed");

  writer.appendParty(token, "build the thing");

  assert.equal(
    content(record),
    "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nNEXT: DeepSeekHarness\n" +
      "\n## DeepSeekHarness @ 2026-01-01T00:00:05.000Z\ndone already\nNEXT: Reviewer\n",
    "the party's section still lands first in the file, whatever order the two calls arrived in",
  );
});

test("a discarded turn appends nothing, for a prompt the bridge refused or the runtime rejected", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.discardTurn(token);
  // Both calls a refused prompt's cleanup and the abandoned turn-end race might still make are no-ops.
  writer.noteTurnEnd("builder", "should never appear", () => "2026-01-01T00:00:00.000Z", "turn_end", "completed", true);
  writer.appendParty(token, "should never appear either");

  assert.equal(content(record), undefined, "the refused prompt's record file is never even created");

  // The control: registering the next turn for the same name works normally, so the no-op above is
  // this turn's own discard rather than a writer that has stopped working for the name.
  const next = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:01:00.000Z"));
  writer.appendParty(next, "a real prompt this time");
  assert.ok(content(record)?.includes("a real prompt this time"));
});

test("a turn's end that reaches this writer inside the still-pending prompt, on a request the bridge then rejects, appends nothing once discarded", (t) => {
  // The exact race the request-timeout branch of `Bridge.prompt` can produce: the runtime finishes
  // the whole turn and `onTurnEnd` runs before the prompt request answers, so `noteTurnEnd` queues a
  // counterparty section for a party section that was never going to be appended, and the request
  // then still times out and the dispatch discards the turn. Nothing must survive that discard.
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.noteTurnEnd("builder", "the runtime's answer, unattributed", () => "2026-01-01T00:00:00.000Z", "turn_end", "completed", true);
  writer.discardTurn(token);

  assert.equal(content(record), undefined, "the queued counterparty section is discarded along with the turn, not flushed later");
});

test("a second prompt for a name whose first turn is still pending does not clobber that turn's own registration", (t) => {
  // The bridge itself refuses a second prompt for a name that already has a turn in flight, but the
  // record writer is asked to register the second one before that refusal has run: registration
  // happens before the prompt request is even sent, and the refusal is something `Bridge.prompt`
  // raises only once it gets there. A name-keyed map would let the second registration overwrite the
  // first turn's still-live entry outright.
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const first = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  assert.notEqual(first, undefined);
  writer.appendParty(first, "task one");

  // The second prompt's own registration attempt, made before `Bridge.prompt` has refused it.
  const second = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:01.000Z"));
  assert.equal(second, undefined, "refused rather than replacing the first turn's still-pending registration");

  // The second prompt's dispatch discards what it holds, which is nothing, since registration
  // refused it; the control is that this is a safe no-op rather than something that reaches back
  // into the first turn's entry.
  writer.discardTurn(second);

  // The first turn's own end still reaches the file, naming the first task, once it actually ends.
  writer.noteTurnEnd("builder", "task one is done", clock("2026-01-01T00:00:05.000Z"), "turn_end", "completed", true);
  assert.equal(
    content(record),
    "## Reviewer @ 2026-01-01T00:00:00.000Z\ntask one\nNEXT: DeepSeekHarness\n" +
      "\n## DeepSeekHarness @ 2026-01-01T00:00:05.000Z\ntask one is done\nNEXT: Reviewer\n",
    "the record holds task one's own two sections, undisturbed by the second prompt's attempt",
  );
});

test("a prompt naming no record for this turn appends nothing, whatever the turn does", () => {
  const writer = new RecordWriter();
  const token = writer.registerTurn("builder", undefined, "Reviewer", "DeepSeekHarness", () => "2026-01-01T00:00:00.000Z");
  assert.equal(token, undefined, "nothing is registered for a turn with no record path");
  // Neither call throws for a name with no record registered, and there is nothing to check them
  // against since no path was ever given to write to.
  writer.appendParty(token, "no record wanted");
  writer.noteTurnEnd("builder", "no record wanted either", () => "2026-01-01T00:00:00.000Z", "turn_end", "completed", true);
});

test("a failed party append drops the whole turn rather than leaving it registered forever", (t) => {
  const dir = workspace(t);
  // A file standing where this record's own parent directory would need to be created: `mkdirSync`
  // fails on it, which is what a real permissions or disk failure looks like to this writer too.
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "not a directory", "utf8");
  const record = path.join(blocker, "sub", "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  assert.throws(() => writer.appendParty(token, "build the thing"));

  // The control: a fresh registration for the same name is not refused, so the failed turn above was
  // dropped rather than left occupying the name.
  const ok = path.join(dir, "record.md");
  const next = writer.registerTurn("builder", ok, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:01:00.000Z"));
  assert.notEqual(next, undefined, "the name is free again once the failed turn was dropped");
});

test("a failed counterparty append drops the whole turn rather than leaving it registered forever", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.appendParty(token, "build the thing");
  // The record file is replaced by a directory of the same name between the party's append and the
  // counterparty's, so the counterparty's own `appendFileSync` fails.
  rmSync(record, { force: true });
  mkdirSync(record);

  assert.throws(() => writer.noteTurnEnd("builder", "done", clock("2026-01-01T00:00:05.000Z"), "turn_end", "completed", true));

  rmSync(record, { recursive: true, force: true });
  const next = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:01:00.000Z"));
  assert.notEqual(next, undefined, "the name is free again once the failed turn was dropped");
});

test(`no more than ${String(MAX_PENDING_TURNS)} turns are held pending at once`, () => {
  const writer = new RecordWriter();
  const tokens = [];
  for (let i = 0; i < MAX_PENDING_TURNS; i += 1) {
    tokens.push(writer.registerTurn(`session-${String(i)}`, `/tmp/record-${String(i)}.md`, "Reviewer", "DeepSeekHarness", () => "2026-01-01T00:00:00.000Z"));
  }
  assert.ok(tokens.every((token) => token !== undefined), "every turn up to the bound registers");

  const overflow = writer.registerTurn("one-too-many", "/tmp/overflow.md", "Reviewer", "DeepSeekHarness", () => "2026-01-01T00:00:00.000Z");
  assert.equal(overflow, undefined, "the bound refuses one more rather than growing without limit");
});

test("rotate refuses an archive_path naming the record itself, and one naming a file that already exists", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  writeFileSync(record, "## Reviewer @ x\nhi\nNEXT: y\n", "utf8");

  assert.throws(() => rotateRecord(record, record), /names the record itself/, "the identical path is refused");
  // A case-different spelling of the same file on a case-insensitive filesystem is the same place.
  if (process.platform === "win32") {
    assert.throws(() => rotateRecord(record, record.toUpperCase()), /names the record itself/, "a case variant of the same path is refused too");
  }

  const existing = path.join(dir, "already-here.md");
  writeFileSync(existing, "someone else's file", "utf8");
  assert.throws(() => rotateRecord(record, existing), /already (names a file that )?exists/, "an existing destination is refused rather than replaced");
  assert.equal(readFileSync(existing, "utf8"), "someone else's file", "and it is left completely untouched");
  assert.equal(readFileSync(record, "utf8"), "## Reviewer @ x\nhi\nNEXT: y\n", "so is the record, since neither refusal touches anything");
});

test("rotate moves the record and the fresh file carries the original's leading header, byte for byte", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const archive = path.join(dir, "archived", "record-1.md");
  const original =
    "# builder\nkept by hand above the first section\n\n" +
    "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nNEXT: DeepSeekHarness\n" +
    "\n## DeepSeekHarness @ 2026-01-01T00:05:00.000Z\ndone\nNEXT: Reviewer\n";
  writeFileSync(record, original, "utf8");

  const archived = rotateRecord(record, archive);

  assert.equal(archived, true, "a record that existed reports that it was archived");
  assert.equal(readFileSync(archive, "utf8"), original, "the archive holds the whole of what the record used to be");
  assert.equal(readFileSync(record, "utf8"), "# builder\nkept by hand above the first section\n\n", "the fresh file carries only the leading header");

  // The control: a record with no operator header rotates to an empty one, so the header above came
  // from the file's own bytes rather than from a writer that invents one.
  const plain = path.join(dir, "plain.md");
  const plainArchive = path.join(dir, "plain-1.md");
  writeFileSync(plain, "## Reviewer @ x\nhi\nNEXT: y\n", "utf8");
  rotateRecord(plain, plainArchive);
  assert.equal(readFileSync(plain, "utf8"), "", "an ordinary bridge-written record has no leading header at all");
});

test("rotating a fresh file whose leading header carries no section line at all succeeds, the false refusal a deleted content guard used to produce on the rotate's own output", (t) => {
  // A rotate's own fresh file, once it carries only an operator's leading header and no section this
  // bridge has appended yet, has no `## ` line in it at all: a guard that read "no such line" as "not
  // a record" refused this bridge's own output on the very next rotate.
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const original = "# builder\nkept by hand above the first section\n\n## Reviewer @ x\nhi\nNEXT: y\n";
  writeFileSync(record, original, "utf8");
  const archive1 = path.join(dir, "archive-1.md");

  const archived1 = rotateRecord(record, archive1);

  assert.equal(archived1, true);
  const fresh = readFileSync(record, "utf8");
  assert.equal(fresh, "# builder\nkept by hand above the first section\n\n", "the fresh file carries only the leading header");
  assert.doesNotMatch(fresh, /^## /m, "and no section line at all, which is the input the deleted guard refused");

  const archive2 = path.join(dir, "archive-2.md");
  const archived2 = rotateRecord(record, archive2);

  assert.equal(archived2, true, "a second rotate of the fresh file the first rotate created also succeeds");
  assert.equal(readFileSync(archive2, "utf8"), fresh, "the second archive holds exactly what the fresh file held");
  assert.equal(readFileSync(record, "utf8"), fresh, "and the file the second rotate leaves behind carries the same header again");
});

test("rotating a record that was never created starts a fresh, empty one, archives nothing, and says so", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const archive = path.join(dir, "record-1.md");

  const archived = rotateRecord(record, archive);

  assert.equal(archived, false, "nothing existed to archive");
  assert.equal(readFileSync(record, "utf8"), "");
  assert.equal(content(archive), undefined, "nothing existed to move");
});

test("rotating a record whose own parent directory does not exist yet creates it, exactly as an append does", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "nested", "deeper", "record.md");
  const archive = path.join(dir, "archive.md");

  const archived = rotateRecord(record, archive);

  assert.equal(archived, false, "nothing existed at a path whose directory did not even exist yet");
  assert.equal(readFileSync(record, "utf8"), "", "the fresh file is created, directory and all");
});

test("noteTurnEnd names a kill or a runtime loss in the section's own header, never in the body, and drops a turn the runtime never accepted without appending anything", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();

  const killed = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.appendParty(killed, "build the thing");
  writer.noteTurnEnd("builder", "", clock("2026-01-01T00:01:00.000Z"), "killed", "killed", true);

  assert.equal(
    content(record),
    "## Reviewer @ 2026-01-01T00:00:00.000Z\nbuild the thing\nNEXT: DeepSeekHarness\n" +
      "\n## DeepSeekHarness @ 2026-01-01T00:01:00.000Z (killed: killed)\n\nNEXT: Reviewer\n",
    "the kind and finish reason ride in the header only; the body is exactly what the runtime said, empty or not",
  );

  // A turn the runtime never accepted appends nothing at all, party or counterparty: nothing was ever
  // promised a turn, so there is no section to write for it.
  writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:02:00.000Z"));
  const before = content(record);
  writer.noteTurnEnd("builder", "unattributed", clock("2026-01-01T00:03:00.000Z"), "error", "unattributed", false);
  assert.equal(content(record), before, "nothing is appended for a turn the runtime never answered");

  // The control: the name is free again, so the turn above was dropped rather than left registered.
  const next = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:04:00.000Z"));
  assert.notEqual(next, undefined, "the name is free once the unaccepted turn was dropped");
});

test("a runtime-supplied finish reason is bounded and neutralized in the header, since the header is not the verbatim body", (t) => {
  const dir = workspace(t);
  const record = path.join(dir, "record.md");
  const writer = new RecordWriter();
  const hostile = `attacker${String.fromCodePoint(0x200b)}reason${"x".repeat(MAX_META_REASON)}`;

  const token = writer.registerTurn("builder", record, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.appendParty(token, "build the thing");
  writer.noteTurnEnd("builder", "", clock("2026-01-01T00:01:00.000Z"), "error", hostile, true);

  const header = content(record)?.split("\n")[4] ?? "";
  const prefix = "## DeepSeekHarness @ 2026-01-01T00:01:00.000Z (error: ";
  assert.ok(header.startsWith(prefix), `the header still names the kind: ${header}`);
  assert.ok(header.endsWith(")"), `the annotation is still closed: ${header}`);
  const reason = header.slice(prefix.length, -1);
  assert.ok(!reason.includes(String.fromCodePoint(0x200b)), "the hidden character is replaced, not carried through");
  assert.ok([...reason].length <= MAX_META_REASON, `the finish reason alone is bounded rather than riding through whole: ${JSON.stringify(reason)}`);
  assert.ok([...reason].length < hostile.length, "the whole hostile string does not ride through unbounded");
});

test("RecordWriter.holdersOf names every session this writer holds a turn open for on one record file, the asking session's own name included", (t) => {
  const dir = workspace(t);
  const shared = path.join(dir, "shared.md");
  const other = path.join(dir, "other.md");
  const writer = new RecordWriter();

  writer.registerTurn("asked", shared, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.registerTurn("sibling", shared, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));
  writer.registerTurn("unrelated", other, "Reviewer", "DeepSeekHarness", clock("2026-01-01T00:00:00.000Z"));

  // "sibling" is holding a turn open and does not share the name the caller asked about, and is
  // still named because the refusal keys on the file. "asked" itself is holding one too and is not
  // special-cased out of its own list.
  assert.deepEqual([...writer.holdersOf(shared)].sort(), ["asked", "sibling"]);
  // The control: a name whose registered turn points at a different file names nobody for the shared
  // path, and the one turn that does point at `other` is named there, so this keys on the file
  // rather than on every registered turn regardless of what it points at.
  assert.deepEqual(writer.holdersOf(other), ["unrelated"]);

  // A name with no turn registered on either file at all, matching what a session that finished
  // cleanly (its turn dropped after both sections flushed) would look like, names nobody.
  const finished = new RecordWriter();
  assert.deepEqual(finished.holdersOf(shared), []);
});
