import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_DETAIL_CHARS,
  MAX_PLAN_CHARS,
  MAX_SESSION_CHARS,
  MAX_TRACKED_PLANS,
  MAX_TS_CHARS,
  defaultEventsPath,
  eventKey,
  fileIdentity,
  initialEventState,
  readEvents,
} from "./events.ts";

const ROOT = "D:\\sapplefeld-channels";
const OTHER_ROOT = "D:\\sapplefeld-ai-os";

type Scratch = { file: string; cleanup: () => void };

function scratch(): Scratch {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-events-"));
  return { file: path.join(dir, "kit-events.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function line(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      ts: "2026-08-16T12:00:00Z",
      event: "goal-blocked",
      project: ROOT,
      plan: "docs/plans/x_spec_v1.md",
      session: "session-1",
      ...overrides,
    }) + "\n"
  );
}

test("a second read returns only what was appended since the first", () => {
  const held = scratch();
  try {
    writeFileSync(held.file, line({ plan: "docs/plans/a_spec_v1.md" }), "utf8");
    const first = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(first.unreadable, false);
    assert.equal(first.state.latest.size, 1);

    appendFileSync(held.file, line({ plan: "docs/plans/b_spec_v1.md" }), "utf8");
    const second = readEvents(first.state, [ROOT], { path: held.file });
    assert.equal(second.state.latest.size, 2, "the first tick's event is still kept, the second is added");
    assert.ok(second.state.offset > first.state.offset, "the offset advanced past only the new bytes");

    // A third tick with nothing appended reads nothing new and holds the same offset.
    const third = readEvents(second.state, [ROOT], { path: held.file });
    assert.equal(third.state.offset, second.state.offset);
    assert.equal(third.state.latest.size, 2);
  } finally {
    held.cleanup();
  }
});

test("a file that shrinks (the kit's rotation) is read from the top again", () => {
  const held = scratch();
  try {
    writeFileSync(held.file, line({ plan: "docs/plans/a_spec_v1.md" }) + line({ plan: "docs/plans/b_spec_v1.md" }), "utf8");
    const first = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(first.state.latest.size, 2);

    // The kit rotates past 1 MB by renaming the old content aside and starting the main path over;
    // from this reader's side that looks exactly like the file becoming smaller than the offset.
    writeFileSync(held.file, line({ plan: "docs/plans/c_spec_v1.md" }), "utf8");
    const second = readEvents(first.state, [ROOT], { path: held.file });
    assert.equal(second.state.offset, heldFileLength(held.file), "read from the top of the smaller file");
    assert.ok(second.state.latest.has(eventKey(ROOT, "docs/plans/c_spec_v1.md")));
    // The earlier pairs are not cleared: a shrink resets the read position, not the kept state.
    assert.equal(second.state.latest.size, 3);
  } finally {
    held.cleanup();
  }
});

function heldFileLength(file: string): number {
  return statSync(file).size;
}

test("a malformed line is skipped and counted, and its neighbors still parse", () => {
  const held = scratch();
  try {
    const body =
      line({ plan: "docs/plans/a_spec_v1.md" }) +
      "not json at all\n" +
      JSON.stringify({ ts: "2026-08-16T12:00:00Z", event: "goal-blocked" }) +
      "\n" + // missing project/plan/session
      line({ plan: "docs/plans/b_spec_v1.md" });
    writeFileSync(held.file, body, "utf8");

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.malformed, 2);
    assert.equal(result.state.latest.size, 2);
  } finally {
    held.cleanup();
  }
});

test("an event for an unconfigured project never surfaces", () => {
  const held = scratch();
  try {
    writeFileSync(held.file, line({ project: "D:\\some-other-project" }), "utf8");
    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.latest.size, 0);
    assert.equal(result.state.malformed, 0, "an event for another project is dropped, not malformed");
  } finally {
    held.cleanup();
  }
});

test("the per-tick read cap bounds a huge append to a coherent partial read", () => {
  const held = scratch();
  try {
    let body = "";
    for (let i = 0; i < 200; i += 1) {
      body += line({ plan: `docs/plans/plan-${i}_spec_v1.md` });
    }
    writeFileSync(held.file, body, "utf8");

    // A cap far smaller than the whole file, but comfortably larger than one line, so the first
    // tick can only consume a prefix of the lines.
    const capped = readEvents(initialEventState(), [ROOT], { path: held.file, maxBytes: 500 });
    assert.ok(capped.state.latest.size > 0, "at least one complete line fit under the cap");
    assert.ok(capped.state.latest.size < 200, "the cap actually bounded the tick's work");
    assert.ok(capped.state.offset > 0 && capped.state.offset < body.length);

    // Repeated ticks at the same small cap make forward progress and eventually catch up.
    let state = capped.state;
    for (let i = 0; i < 100 && state.latest.size < 200; i += 1) {
      state = readEvents(state, [ROOT], { path: held.file, maxBytes: 500 }).state;
    }
    assert.equal(state.latest.size, 200, "repeated capped ticks eventually consume the whole append");
    assert.equal(state.offset, body.length);
  } finally {
    held.cleanup();
  }
});

test("the latest event per (project, plan) wins in both directions", () => {
  const held = scratch();
  try {
    // A newer goal-complete beats an older goal-blocked for the same pair.
    const bodyA =
      line({ plan: "docs/plans/a_spec_v1.md", event: "goal-blocked" }) +
      line({ plan: "docs/plans/a_spec_v1.md", event: "goal-complete", detail: "plan-complete" });
    writeFileSync(held.file, bodyA, "utf8");
    const resultA = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(resultA.state.latest.get(eventKey(ROOT, "docs/plans/a_spec_v1.md"))?.event, "goal-complete");

    // A newer goal-blocked beats an older goal-complete for the same pair (a plan reopened and
    // blocked again after finishing once).
    const held2 = scratch();
    const bodyB =
      line({ plan: "docs/plans/b_spec_v1.md", event: "goal-complete", detail: "plan-complete" }) +
      line({ plan: "docs/plans/b_spec_v1.md", event: "goal-blocked" });
    writeFileSync(held2.file, bodyB, "utf8");
    try {
      const resultB = readEvents(initialEventState(), [ROOT], { path: held2.file });
      assert.equal(resultB.state.latest.get(eventKey(ROOT, "docs/plans/b_spec_v1.md"))?.event, "goal-blocked");
    } finally {
      held2.cleanup();
    }
  } finally {
    held.cleanup();
  }
});

test("an absent file yields an empty state, not a failure", () => {
  const held = scratch();
  try {
    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.unreadable, false);
    assert.equal(result.state.latest.size, 0);
    assert.equal(result.state.offset, 0);
  } finally {
    held.cleanup();
  }
});

test("an over-long field is bounded rather than kept whole, and the project is matched as written", () => {
  const held = scratch();
  try {
    // A project path far longer than any field cap, which Windows allows with long paths enabled.
    // It is configured verbatim, because a root is configuration and is never truncated: the reader
    // has to match the raw value it is given or an event for this project could never surface.
    const longRoot = ROOT + "x".repeat(400);
    writeFileSync(
      held.file,
      line({
        event: "goal-complete",
        project: longRoot,
        plan: "p".repeat(400),
        session: "s".repeat(400),
        detail: "d".repeat(400),
      }),
      "utf8",
    );

    const result = readEvents(initialEventState(), [longRoot], { path: held.file });
    const kept = result.state.latest.get(eventKey(longRoot, "p".repeat(MAX_PLAN_CHARS)));
    assert.ok(kept, "the untruncated project matched its configured root");
    assert.equal(kept?.root, longRoot, "the kept root is the configured string, whole");
    assert.equal(kept?.plan.length, MAX_PLAN_CHARS);
    assert.equal(kept?.session?.length, MAX_SESSION_CHARS);
    assert.equal(kept?.detail?.length, MAX_DETAIL_CHARS);
  } finally {
    held.cleanup();
  }
});

test("a cut that would land inside a surrogate pair backs off instead of splitting it", () => {
  const held = scratch();
  try {
    // The astral character straddles the cap, so keeping the first half of it would leave a lone
    // surrogate in state that no sink can encode.
    const straddling = "a".repeat(MAX_SESSION_CHARS - 1) + "😀" + "tail";
    // One unit later the cap falls on an ordinary character and the full allowance is kept.
    const clear = "a".repeat(MAX_SESSION_CHARS) + "😀" + "tail";
    writeFileSync(held.file, line({ session: straddling }) + line({ plan: "b.md", session: clear }), "utf8");

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    const backedOff = result.state.latest.get(eventKey(ROOT, "docs/plans/x_spec_v1.md"))?.session;
    assert.equal(backedOff, "a".repeat(MAX_SESSION_CHARS - 1), "the astral character was dropped whole");
    assert.equal(result.state.latest.get(eventKey(ROOT, "b.md"))?.session, "a".repeat(MAX_SESSION_CHARS));
  } finally {
    held.cleanup();
  }
});

test("a ts is bounded and has to name an instant, or the line is malformed", () => {
  const held = scratch();
  try {
    assert.ok(
      "2026-08-16T12:00:00.000+00:00".length <= MAX_TS_CHARS,
      "a real ISO stamp fits inside the cap, so no honest line is refused by it",
    );
    writeFileSync(
      held.file,
      line({ plan: "good.md" }) +
        line({ plan: "wordy.md", ts: "sometime last Tuesday" }) +
        line({ plan: "huge.md", ts: "2026-08-16T12:00:00Z" + "x".repeat(50_000) }),
      "utf8",
    );

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.malformed, 2, "both unusable timestamps are malformed lines");
    assert.equal(result.state.latest.size, 1);
    assert.equal(result.state.latest.get(eventKey(ROOT, "good.md"))?.ts, "2026-08-16T12:00:00Z");
    for (const kept of result.state.latest.values()) {
      assert.ok(kept.ts.length <= MAX_TS_CHARS, "nothing longer than the cap reaches kept state");
    }
  } finally {
    held.cleanup();
  }
});

test("a line with no session key is malformed while a line with no detail is not", () => {
  const held = scratch();
  try {
    // The kit's contract carries `session` on every line and `detail` only on a `goal-complete`, so
    // an absent session is a line this reader cannot place and an absent detail is an ordinary one.
    writeFileSync(
      held.file,
      line({ plan: "sessionless.md", session: undefined }) +
        line({ plan: "detailless.md", event: "goal-complete" }) +
        line({ plan: "nulled.md", session: null }),
      "utf8",
    );

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.malformed, 1);
    assert.equal(result.state.latest.has(eventKey(ROOT, "sessionless.md")), false);
    assert.equal(result.state.latest.get(eventKey(ROOT, "detailless.md"))?.detail, null);
    assert.equal(result.state.latest.get(eventKey(ROOT, "nulled.md"))?.session, null);
  } finally {
    held.cleanup();
  }
});

test("the kept map is the previous instance when a tick keeps nothing and a new one when it keeps something", () => {
  const held = scratch();
  try {
    const start = initialEventState();
    writeFileSync(held.file, "not json at all\n" + line({ project: "D:\\some-other-project" }), "utf8");
    const quiet = readEvents(start, [ROOT], { path: held.file });
    assert.equal(quiet.state.malformed, 1, "the tick did read complete lines");
    assert.equal(quiet.state.latest, start.latest, "nothing was kept, so the map is the same instance");

    appendFileSync(held.file, line({ plan: "kept.md" }), "utf8");
    const moved = readEvents(quiet.state, [ROOT], { path: held.file });
    assert.notEqual(moved.state.latest, quiet.state.latest, "a kept event makes a new map");
    assert.equal(moved.state.latest.size, 1);
  } finally {
    held.cleanup();
  }
});

test("the kept map stops at MAX_TRACKED_PLANS, evicting the oldest insertion", () => {
  const held = scratch();
  try {
    let body = "";
    for (let i = 0; i < MAX_TRACKED_PLANS + 5; i += 1) body += line({ plan: `plan-${i}.md` });
    writeFileSync(held.file, body, "utf8");

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.latest.size, MAX_TRACKED_PLANS);
    assert.equal(result.state.latest.has(eventKey(ROOT, "plan-0.md")), false, "the oldest gave way");
    assert.ok(
      result.state.latest.has(eventKey(ROOT, `plan-${MAX_TRACKED_PLANS + 4}.md`)),
      "the newest is kept",
    );
  } finally {
    held.cleanup();
  }
});

test("two pairs that differ only where a space could fall stay distinct", () => {
  const held = scratch();
  try {
    // Joined by a space, these two (root, plan) pairs produce one key and one entry takes the
    // other's project.
    const spaced = "D:\\My Projects\\alpha";
    const clipped = "D:\\My";
    writeFileSync(
      held.file,
      line({ project: spaced, plan: "x.md" }) +
        line({ project: clipped, plan: "Projects\\alpha x.md", event: "goal-complete" }),
      "utf8",
    );

    const result = readEvents(initialEventState(), [spaced, clipped], { path: held.file });
    assert.equal(result.state.latest.size, 2);
    assert.equal(result.state.latest.get(eventKey(spaced, "x.md"))?.event, "goal-blocked");
    assert.equal(result.state.latest.get(eventKey(clipped, "Projects\\alpha x.md"))?.event, "goal-complete");
  } finally {
    held.cleanup();
  }
});

test("a line longer than the whole read cap is counted malformed and stepped over", () => {
  const held = scratch();
  try {
    // No window of 500 bytes starting at this line's first byte can contain its newline, so a
    // reader that held for one would never reach the event behind it.
    writeFileSync(
      held.file,
      "x".repeat(2_000) + "\n" + line({ plan: "docs/plans/behind_spec_v1.md", event: "goal-complete" }),
      "utf8",
    );

    let state = initialEventState();
    for (let i = 0; i < 10 && state.latest.size === 0; i += 1) {
      state = readEvents(state, [ROOT], { path: held.file, maxBytes: 500 }).state;
    }
    assert.equal(state.latest.size, 1, "the event behind the over-cap line is consumed");
    assert.equal(
      state.latest.get(eventKey(ROOT, "docs/plans/behind_spec_v1.md"))?.event,
      "goal-complete",
    );
    assert.ok(state.malformed >= 1, "the over-cap line is counted, not silently dropped");
    assert.equal(state.offset, heldFileLength(held.file));
  } finally {
    held.cleanup();
  }
});

test("a partial line inside an unfilled window still holds the offset for the next tick", () => {
  const held = scratch();
  try {
    // A writer's append caught in flight: the window is nowhere near the cap, so the bytes are not
    // a line that will never end, they are a line that has not ended yet.
    writeFileSync(held.file, '{"ts":"2026-08-16T12:00:00Z","event":"goal-b', "utf8");
    const result = readEvents(initialEventState(), [ROOT], { path: held.file, maxBytes: 500 });
    assert.equal(result.state.offset, 0, "the offset holds so the whole line is re-read");
    assert.equal(result.state.malformed, 0, "an unfinished line is not a malformed one");

    writeFileSync(held.file, line({ plan: "finished.md" }), "utf8");
    const second = readEvents(result.state, [ROOT], { path: held.file, maxBytes: 500 });
    assert.equal(second.state.latest.size, 1);
  } finally {
    held.cleanup();
  }
});

test("the offset counts the file's own bytes, not a re-encoding of the decoded text", () => {
  const held = scratch();
  try {
    // Three bytes that are not valid UTF-8. Decoding turns each into a replacement character that
    // re-encodes to three bytes, so an offset measured over the decoded text would run six bytes
    // past the end of what was actually consumed and eat the head of the next line.
    const body = Buffer.concat([
      Buffer.from("garbage "),
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from("\n" + line({ plan: "first.md" })),
    ]);
    writeFileSync(held.file, body);

    const first = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(first.state.malformed, 1, "the junk line is malformed");
    assert.equal(first.state.offset, heldFileLength(held.file), "the offset lands exactly at the end");

    appendFileSync(held.file, line({ plan: "second.md" }), "utf8");
    const second = readEvents(first.state, [ROOT], { path: held.file });
    assert.equal(second.state.malformed, 1, "the appended line was read whole, not from its middle");
    assert.ok(second.state.latest.has(eventKey(ROOT, "second.md")));
  } finally {
    held.cleanup();
  }
});

test("a configured root entered with a trailing separator still matches its own project", () => {
  const held = scratch();
  try {
    const project = path.join(os.tmpdir(), "a-project");
    writeFileSync(held.file, line({ project }), "utf8");

    const kept = readEvents(initialEventState(), [project + path.sep], { path: held.file });
    assert.equal(kept.state.latest.size, 1, "the trailing separator names the same directory");
    assert.equal([...kept.state.latest.values()][0]?.root, project + path.sep, "the root rides out as configured");

    const dropped = readEvents(initialEventState(), [project + "-two"], { path: held.file });
    assert.equal(dropped.state.latest.size, 0, "a different directory still matches nothing");
  } finally {
    held.cleanup();
  }
});

test(
  "a project differing from its root only in drive-letter case still matches",
  { skip: process.platform !== "win32" },
  () => {
    const held = scratch();
    try {
      writeFileSync(held.file, line({ project: ROOT.toLowerCase() }), "utf8");
      const kept = readEvents(initialEventState(), [ROOT], { path: held.file });
      assert.equal(kept.state.latest.size, 1, "case is not a distinction this filesystem makes");

      const dropped = readEvents(initialEventState(), [OTHER_ROOT], { path: held.file });
      assert.equal(dropped.state.latest.size, 0, "a genuinely different root still matches nothing");
    } finally {
      held.cleanup();
    }
  },
);

test("a rotated file that has already regrown past the offset is read from the top", () => {
  const held = scratch();
  try {
    writeFileSync(held.file, line({ plan: "a.md" }) + line({ plan: "b.md" }), "utf8");
    const first = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(first.state.latest.size, 2);

    // The kit's rotation renames the file aside and starts a new one at the same path. This one is
    // already longer than the offset by the time the next tick looks, so nothing about its size
    // says a rotation happened; only its identity does.
    renameSync(held.file, held.file + ".old");
    writeFileSync(
      held.file,
      line({ plan: "c.md" }) + line({ plan: "d.md" }) + line({ plan: "e.md" }),
      "utf8",
    );

    const second = readEvents(first.state, [ROOT], { path: held.file });
    assert.equal(second.state.offset, heldFileLength(held.file), "read from the top of the new file");
    assert.equal(second.state.latest.size, 5, "every line of the new file was seen");
    assert.ok(second.state.latest.has(eventKey(ROOT, "c.md")), "the line below the old offset is not skipped");
  } finally {
    rmSync(held.file + ".old", { force: true });
    held.cleanup();
  }
});

test("a file identity carries the whole inode, so two files a whisker apart stay two files", () => {
  // A 64-bit NTFS file id sits where a double's ulp is 1024, so these two neighbors round to one
  // number and the rotation check that runs on them stops being able to tell the files apart.
  const one = fileIdentity({ dev: 66_306n, ino: 4_611_686_018_430_553_142n });
  const two = fileIdentity({ dev: 66_306n, ino: 4_611_686_018_430_553_143n });
  assert.notEqual(one, two, "neighboring inodes are distinct identities");
  assert.equal(
    fileIdentity({ dev: 66_306n, ino: 4_611_686_018_430_553_142n }),
    one,
    "the same file is the same identity",
  );
  assert.notEqual(fileIdentity({ dev: 66_307n, ino: 4_611_686_018_430_553_142n }), one, "the device counts too");
  assert.equal(fileIdentity({ dev: 66_306n, ino: 0n }), null, "no usable inode is no identity at all");
});

test("a ts without an explicit offset is malformed, and either offset form is kept", () => {
  const held = scratch();
  try {
    // An offset-less stamp reads as this host's local time, which moves the instant by the host's
    // offset and with it every comparison the blocked marker's clear rule makes.
    writeFileSync(
      held.file,
      line({ plan: "local.md", ts: "2026-08-16T12:00:00" }) +
        line({ plan: "wordy.md", ts: "August 16, 2026" }) +
        line({ plan: "zulu.md", ts: "2026-08-16T12:00:00Z" }) +
        line({ plan: "offset.md", ts: "2026-08-16T12:00:00.000+02:00" }) +
        line({ plan: "compact.md", ts: "2026-08-16T12:00:00+0200" }),
      "utf8",
    );

    const result = readEvents(initialEventState(), [ROOT], { path: held.file });
    assert.equal(result.state.malformed, 2, "both offset-less stamps are malformed lines");
    assert.equal(result.state.latest.has(eventKey(ROOT, "local.md")), false);
    assert.equal(result.state.latest.has(eventKey(ROOT, "wordy.md")), false);
    assert.equal(result.state.latest.get(eventKey(ROOT, "zulu.md"))?.ts, "2026-08-16T12:00:00Z");
    assert.equal(result.state.latest.get(eventKey(ROOT, "offset.md"))?.ts, "2026-08-16T12:00:00.000+02:00");
    assert.equal(result.state.latest.get(eventKey(ROOT, "compact.md"))?.ts, "2026-08-16T12:00:00+0200");
  } finally {
    held.cleanup();
  }
});

test("defaultEventsPath resolves ~/.claude/kit-events.jsonl and reads no knob of its own", () => {
  // The `CHANNEL_BOARD_EVENTS_PATH` override is broker/config.ts's to read and apply, so that the
  // installer's allowlist pin, which scans that file for the knobs it must carry, sees it. Reading
  // it here as well would put the knob back outside the pin's sight.
  const knobbed = defaultEventsPath({
    CHANNEL_BOARD_EVENTS_PATH: "D:\\custom\\events.jsonl",
    USERPROFILE: "D:\\Users\\op",
  } as NodeJS.ProcessEnv);
  assert.equal(knobbed, path.join("D:\\Users\\op", ".claude", "kit-events.jsonl"));

  const withoutOverride = defaultEventsPath({ USERPROFILE: "D:\\Users\\op" } as NodeJS.ProcessEnv);
  assert.equal(withoutOverride, path.join("D:\\Users\\op", ".claude", "kit-events.jsonl"));

  // A blank profile is as absent as a missing one: taken literally it would build a path relative
  // to whatever directory the broker was launched from.
  const homed = path.join(os.homedir(), ".claude", "kit-events.jsonl");
  assert.equal(defaultEventsPath({ USERPROFILE: "   " } as NodeJS.ProcessEnv), homed);
  assert.equal(defaultEventsPath({} as NodeJS.ProcessEnv), homed);
  assert.ok(path.isAbsolute(defaultEventsPath({ USERPROFILE: "" } as NodeJS.ProcessEnv)));

  assert.notEqual(OTHER_ROOT, ROOT, "sanity: the two fixture roots used across this file are distinct");
});
