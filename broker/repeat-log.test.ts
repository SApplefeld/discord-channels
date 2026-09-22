// The shared repeat logger. Two things carry the weight here: the counting core behaves the same
// for every surface (the first line, the silent repeat, the count line on the window's close, the
// sweep past a key cap, and a window that a throwing log cannot leave stale), and each of the eight
// surfaces still writes its own text, window and cap, which operators and memory records grep for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_CARD_REPEAT_LOG } from "./board/thread.ts";
import { PINS_REPEAT_LOG } from "./discord/pins.ts";
import { JUDGE_REPEAT_LOG } from "./inbox/judge.ts";
import { INBOX_CARD_REPEAT_LOG } from "./inbox/thread.ts";
import { QUESTION_DESK_REPEAT_LOG } from "./question-desk.ts";
import { createRepeatLog } from "./repeat-log.ts";
import type { RepeatLogSurface } from "./repeat-log.ts";
import { ROUTING_REPEAT_LOG } from "./routing/interactions.ts";
import { TAIL_REPEAT_LOG } from "./tail.ts";
import { USAGE_CARD_REPEAT_LOG } from "./usage/thread.ts";

const WINDOW_MS = 1_000;

/** A surface whose lines name what they are, so each assertion reads which line was written. */
function surface(maxKeys?: number): RepeatLogSurface<[detail: string]> {
  return {
    windowMs: WINDOW_MS,
    maxKeys,
    firstLine: (key, detail) => `first ${key} (${detail})`,
    countLine: (key, suppressed) => `count ${key} ${String(suppressed)}`,
  };
}

type Harness = {
  at: (ms: number) => void;
  now: () => number;
  log: (line: string) => void;
  take: () => string[];
};

/** A clock the test sets, and the lines written since the last `take`. */
function harness(): Harness {
  let clock = 0;
  let lines: string[] = [];
  return {
    at: (ms) => {
      clock = ms;
    },
    now: () => clock,
    log: (line) => {
      lines.push(line);
    },
    take: () => {
      const taken = lines;
      lines = [];
      return taken;
    },
  };
}

test("the first call of a key writes its first line", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(), h.log, h.now);

  repeats("cause", "detail");
  assert.deepEqual(h.take(), ["first cause (detail)"]);
});

test("a repeat inside the window writes nothing, whatever its detail", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(), h.log, h.now);
  repeats("cause", "one");
  h.take();

  h.at(WINDOW_MS - 1);
  repeats("cause", "two");
  repeats("cause", "three");
  assert.deepEqual(h.take(), []);
});

test("the window's close writes the count line and then the new first line", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(), h.log, h.now);
  repeats("cause", "one");
  h.at(10);
  repeats("cause", "two");
  repeats("cause", "three");
  h.take();

  h.at(WINDOW_MS);
  repeats("cause", "four");
  assert.deepEqual(h.take(), ["count cause 2", "first cause (four)"]);

  // A window that counted nothing closes with no count line.
  h.at(2 * WINDOW_MS);
  repeats("cause", "five");
  assert.deepEqual(h.take(), ["first cause (five)"]);
});

test("past the key cap the oldest closed windows are swept, each writing the count it owes", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(2), h.log, h.now);
  repeats("a", "x");
  h.at(100);
  repeats("b", "x");
  h.at(200);
  repeats("a", "x");
  repeats("b", "x");
  h.take();

  // Both windows are closed and both owe one; the map is one over the cap, so only the oldest goes.
  h.at(2_000);
  repeats("c", "x");
  assert.deepEqual(h.take(), ["first c (x)", "count a 1"]);

  // The swept key's count was written on the way out, so its return owes nothing, and taking the
  // map over the cap again sweeps the next oldest closed window.
  h.at(2_050);
  repeats("a", "x");
  assert.deepEqual(h.take(), ["first a (x)", "count b 1"]);
});

test("an open window is never swept, even past the key cap", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(1), h.log, h.now);
  repeats("a", "x");
  h.at(500);
  repeats("b", "x");
  assert.deepEqual(h.take(), ["first a (x)", "first b (x)"]);

  // Still held: a repeat inside its window is counted, not written as a fresh line.
  h.at(600);
  repeats("a", "x");
  assert.deepEqual(h.take(), []);
});

test("without a key cap nothing is swept, and a pending count waits for its own key", () => {
  const h = harness();
  const repeats = createRepeatLog(surface(), h.log, h.now);
  for (let index = 0; index < 100; index += 1) {
    repeats(`k${String(index)}`, "x");
    repeats(`k${String(index)}`, "x");
  }
  h.take();

  h.at(WINDOW_MS);
  repeats("new", "x");
  assert.deepEqual(h.take(), ["first new (x)"]);

  repeats("k0", "x");
  assert.deepEqual(h.take(), ["count k0 1", "first k0 (x)"]);
});

test("the window is refreshed before either line is written, so a throwing log cannot leave it stale", () => {
  const h = harness();
  let failing = true;
  const repeats = createRepeatLog(
    surface(),
    (line) => {
      if (failing) throw new Error("log failed");
      h.log(line);
    },
    h.now,
  );

  // A throwing first line still opens the window: the repeat inside it is counted, not written.
  assert.throws(() => repeats("cause", "one"), /log failed/);
  failing = false;
  h.at(10);
  repeats("cause", "two");
  assert.deepEqual(h.take(), []);

  // A throwing count line still closes the window it reports and opens the next one.
  failing = true;
  h.at(WINDOW_MS);
  assert.throws(() => repeats("cause", "three"), /log failed/);
  failing = false;
  h.at(WINDOW_MS + 10);
  repeats("cause", "four");
  assert.deepEqual(h.take(), []);
});

/**
 * One surface's pinned text, window and cap. The expected lines are this surface's own text as each
 * module wrote it before the logger had one owner, with the key `cause`, the details `first` and
 * `second` where the surface carries one, and two repeats counted. The call adapts each surface's
 * own call shape to one signature, so the pins can run as one table.
 */
type SurfacePin = {
  name: string;
  open: (log: (line: string) => void, now: () => number) => (key: string, detail: string) => void;
  windowMs: number;
  maxKeys: number | undefined;
  first: string;
  count: string;
  second: string;
};

const PINS: SurfacePin[] = [
  {
    name: "tailer",
    open: (log, now) => {
      const repeats = createRepeatLog(TAIL_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 60_000,
    maxKeys: 64,
    first: "tail: cause (first)",
    count: "tail: cause occurred 2 more time(s) in the last 60000ms",
    second: "tail: cause (second)",
  },
  {
    name: "question desk",
    open: (log, now) => {
      const repeats = createRepeatLog(QUESTION_DESK_REPEAT_LOG, log, now);
      return (key) => repeats(key);
    },
    windowMs: 60_000,
    maxKeys: 64,
    first: "question desk: cause",
    count: "question desk: cause occurred 2 more time(s) in the last 60000ms",
    second: "question desk: cause",
  },
  {
    name: "interaction router",
    open: (log, now) => {
      const repeats = createRepeatLog(ROUTING_REPEAT_LOG, log, now);
      return (key) => repeats(key);
    },
    windowMs: 60_000,
    maxKeys: 64,
    first: "routing: cause",
    count: "routing: cause occurred 2 more time(s) in the last 60000ms",
    second: "routing: cause",
  },
  {
    name: "inbox judge",
    open: (log, now) => {
      const repeats = createRepeatLog(JUDGE_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 60_000,
    maxKeys: undefined,
    first: "inbox judge: cause session=first",
    count: "inbox judge: cause occurred 2 more time(s) in the last 60000ms",
    second: "inbox judge: cause session=second",
  },
  {
    name: "pin keeper",
    open: (log, now) => {
      const repeats = createRepeatLog(PINS_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 300_000,
    maxKeys: undefined,
    first: "discord pins: cause (first)",
    count: "discord pins: cause occurred 2 more time(s) in the last 5 minutes",
    second: "discord pins: cause (second)",
  },
  {
    name: "usage card",
    open: (log, now) => {
      const repeats = createRepeatLog(USAGE_CARD_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 300_000,
    maxKeys: undefined,
    first: "usage card: cause (first)",
    count: "usage card: cause occurred 2 more time(s) in the last 5 minutes",
    second: "usage card: cause (second)",
  },
  {
    name: "board card",
    open: (log, now) => {
      const repeats = createRepeatLog(BOARD_CARD_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 300_000,
    maxKeys: undefined,
    first: "board card: cause (first)",
    count: "board card: cause occurred 2 more time(s) in the last 5 minutes",
    second: "board card: cause (second)",
  },
  {
    name: "inbox card",
    open: (log, now) => {
      const repeats = createRepeatLog(INBOX_CARD_REPEAT_LOG, log, now);
      return (key, detail) => repeats(key, detail);
    },
    windowMs: 300_000,
    maxKeys: undefined,
    first: "inbox card: cause (first)",
    count: "inbox card: cause occurred 2 more time(s) in the last 5 minutes",
    second: "inbox card: cause (second)",
  },
];

for (const pin of PINS) {
  test(`the ${pin.name} writes its own first line and count line over its own window`, () => {
    const h = harness();
    const repeats = pin.open(h.log, h.now);

    repeats("cause", "first");
    assert.deepEqual(h.take(), [pin.first]);

    // The last millisecond of the window still counts the repeat rather than writing it.
    h.at(pin.windowMs - 1);
    repeats("cause", "first");
    repeats("cause", "first");
    assert.deepEqual(h.take(), []);

    h.at(pin.windowMs);
    repeats("cause", "second");
    assert.deepEqual(h.take(), [pin.count, pin.second]);
  });
}

test("each surface keeps its own key cap", () => {
  const caps = {
    tailer: TAIL_REPEAT_LOG.maxKeys,
    "question desk": QUESTION_DESK_REPEAT_LOG.maxKeys,
    "interaction router": ROUTING_REPEAT_LOG.maxKeys,
    "inbox judge": JUDGE_REPEAT_LOG.maxKeys,
    "pin keeper": PINS_REPEAT_LOG.maxKeys,
    "usage card": USAGE_CARD_REPEAT_LOG.maxKeys,
    "board card": BOARD_CARD_REPEAT_LOG.maxKeys,
    "inbox card": INBOX_CARD_REPEAT_LOG.maxKeys,
  };
  assert.deepEqual(caps, Object.fromEntries(PINS.map((pin) => [pin.name, pin.maxKeys])));
});
