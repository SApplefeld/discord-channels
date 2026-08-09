// The question desk. Two properties carry the weight here: a held response resolves exactly once,
// whichever of the five triggers wins the race, and every failure direction lands on the release,
// so a lost hold costs the operator a console walk and never a question.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { AskedQuestion } from "./discord/render.ts";
import { MAX_HELD_QUESTIONS, MAX_RESPONSES_PER_ENTRY, createQuestionDesk } from "./question-desk.ts";
import type { QuestionTerminalState } from "./question-desk.ts";
import { questionDigest } from "./tail.ts";

// SECRET- prefixed like the intake's question fixtures: the no-content-in-logs assertions grep for
// it, so a log line quoting any part of a question turns a silent leak into a red test.
const QUESTION = "SECRET-which beverage should power this session?";

/** The bounded parse of one ask, the desk's digest source. */
function ask(question: string = QUESTION): AskedQuestion[] {
  return [
    {
      question,
      header: "Beverage",
      multiSelect: false,
      options: ["SECRET-Coffee", "SECRET-Tea"],
    },
  ];
}

/** The payload's own questions array, the verbatim form an answered hold passes back. */
function askInput(question: string = QUESTION): unknown[] {
  return [
    {
      question,
      header: "Beverage",
      options: [
        { label: "SECRET-Coffee", description: "SECRET-the classic" },
        { label: "SECRET-Tea", description: "SECRET-gentler" },
      ],
      multiSelect: false,
    },
  ];
}

type Write = { status: number; headers: Record<string, string>; body: unknown };

/**
 * A response the desk can hold: writes are captured, a double end() throws the way a real socket
 * write after end errors, and close() is the client giving up, after which nothing is writable.
 *
 * A write is buffered until `finish()` says it reached the wire, which is the state shutdown's
 * flush wait reads: a real response reports `writableFinished` only once the data is handed off,
 * and everything in between is what a socket teardown would drop.
 */
function heldResponse(): {
  response: ServerResponse;
  writes: Write[];
  close: () => void;
  finish: () => void;
} {
  const writes: Write[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let status = 0;
  let headers: Record<string, string> = {};
  const fire = (event: string): void => {
    for (const listener of listeners.get(event)?.splice(0) ?? []) listener();
  };
  const response = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead(code: number, sent: Record<string, string>) {
      if (this.destroyed) throw new Error("write after the socket is gone");
      status = code;
      headers = sent;
      return this;
    },
    end(text: string) {
      if (this.writableEnded) throw new Error("end() called twice on one response");
      this.writableEnded = true;
      writes.push({ status, headers, body: JSON.parse(text) });
    },
    once(event: string, listener: () => void) {
      const held = listeners.get(event) ?? [];
      held.push(listener);
      listeners.set(event, held);
      return this;
    },
  };
  return {
    response: response as unknown as ServerResponse,
    writes,
    close: () => {
      response.destroyed = true;
      fire("close");
    },
    finish: () => {
      response.writableFinished = true;
      fire("finish");
    },
  };
}

/** Hand-driven timers, so a test fires expiry deterministically instead of sleeping four hours. */
function fakeTimers(): {
  setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (timer: NodeJS.Timeout) => void;
  fire: () => void;
  pending: () => number;
} {
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  return {
    setTimer: (callback) => {
      const entry = { callback, cleared: false };
      timers.push(entry);
      return entry as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    },
    fire: () => {
      for (const entry of timers.splice(0)) {
        if (!entry.cleared) entry.callback();
      }
    },
    pending: () => timers.filter((entry) => !entry.cleared).length,
  };
}

function harness(options: { onTerminal?: (sessionId: string, state: QuestionTerminalState) => void } = {}) {
  const timers = fakeTimers();
  const logged: string[] = [];
  const terminals: Array<{ sessionId: string; state: QuestionTerminalState }> = [];
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    log: (message) => logged.push(message),
    onTerminal:
      options.onTerminal ?? ((sessionId, state) => terminals.push({ sessionId, state })),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { desk, timers, logged, terminals };
}

test("an answered hold responds with the measured allow shape, questions passed back verbatim", () => {
  const { desk, terminals } = harness();
  const { response, writes } = heldResponse();

  assert.equal(desk.hold("session-a", ask(), askInput(), response, true), true);
  assert.equal(writes.length, 0, "a held response receives nothing until resolution");

  // Both answer spellings of the measured vocabulary ride one map: a single-select answers with
  // an option label string, a multi-select with an array of labels.
  const answers = { [QUESTION]: "SECRET-Coffee", "SECRET-second": ["SECRET-Tea"] };
  assert.equal(desk.resolve("session-a", { kind: "answers", answers }), true);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].headers["content-type"], "application/json");
  assert.deepEqual(writes[0].body, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions: askInput(), answers },
    },
  });
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "answered" }]);
});

test("a free-form resolution carries response in place of answers", () => {
  const { desk } = harness();
  const { response, writes } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);

  assert.equal(desk.resolve("session-a", { kind: "response", response: "SECRET-in my own words" }), true);
  assert.deepEqual(writes[0].body, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions: askInput(), response: "SECRET-in my own words" },
    },
  });
});

test("release and expiry both answer the no-decision {}, under their own terminal states", () => {
  // The same body on purpose: {} is measured to render the console picker normally, and both
  // triggers mean "answer at the console". They stay distinct states because the thread message
  // they will edit says different things.
  const { desk, timers, terminals } = harness();

  const released = heldResponse();
  desk.hold("session-a", ask(), askInput(), released.response, true);
  assert.equal(desk.release("session-a"), true);
  assert.equal(released.writes.length, 1);
  assert.equal(released.writes[0].status, 200);
  assert.deepEqual(released.writes[0].body, {});

  const expired = heldResponse();
  desk.hold("session-b", ask(), askInput(), expired.response, true);
  timers.fire();
  assert.deepEqual(expired.writes[0].body, {});

  assert.deepEqual(terminals, [
    { sessionId: "session-a", state: "released" },
    { sessionId: "session-b", state: "expired" },
  ]);
});

test("a resolution racing expiry resolves exactly once, whichever lands first", () => {
  const { desk, timers, terminals } = harness();

  // Expiry first: the late answer finds nothing held, resolves nothing, and writes nothing.
  const first = heldResponse();
  desk.hold("session-a", ask(), askInput(), first.response, true);
  timers.fire();
  assert.deepEqual(first.writes[0].body, {});
  assert.equal(
    desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } }),
    false,
    "an answer landing after expiry resolves nothing",
  );
  assert.equal(first.writes.length, 1, "and writes nothing over the release");

  // Answer first: settling clears the timer, so a pending expiry fires into nothing.
  const second = heldResponse();
  desk.hold("session-b", ask(), askInput(), second.response, true);
  assert.equal(
    desk.resolve("session-b", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } }),
    true,
  );
  timers.fire();
  assert.equal(second.writes.length, 1, "expiry after an answer writes nothing");

  assert.deepEqual(
    terminals.map((entry) => entry.state),
    ["expired", "answered"],
    "each entry reaches exactly one terminal state",
  );
});

test("a socket closing first cleans the entry: no response, no throw, nothing left to resolve", () => {
  // The client-gone trigger is load-bearing beyond crashes: a host still running the short
  // pre-hold hook timeout closes the socket under every hold, and the desk has to notice.
  const { desk, timers, terminals } = harness();
  const { response, writes, close } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);

  close();
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "client-gone" }]);
  assert.equal(timers.pending(), 0, "the expiry timer is cleared with the entry");

  // The late resolution finds nothing and must not touch the dead socket, whose fake throws on
  // any write.
  assert.doesNotThrow(() =>
    assert.equal(
      desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } }),
      false,
    ),
  );
  assert.deepEqual(writes, [], "nothing is ever written to a closed response");
});

test("the desk's own write completing does not read as a client-gone close", () => {
  // A real response emits close after a normal end too; only a response still held when its
  // close fires is a death.
  const { desk, terminals } = harness();
  const { response, close } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);
  desk.release("session-a");

  close();
  assert.deepEqual(
    terminals,
    [{ sessionId: "session-a", state: "released" }],
    "the close after the desk's own write reports no second terminal state",
  );
});

test("a digest-matching retry attaches, and both responses are answered identically", () => {
  // The CLI retrying the one ask it is parked on: one entry, one expiry clock, two sockets that
  // both deserve the answer.
  const { desk, timers, terminals } = harness();
  const first = heldResponse();
  const second = heldResponse();
  assert.equal(desk.hold("session-a", ask(), askInput(), first.response, true), true);
  assert.equal(desk.hold("session-a", ask(), askInput(), second.response, true), true);
  assert.equal(timers.pending(), 1, "a retry attaches to the entry's original clock");

  desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } });
  assert.equal(first.writes.length, 1);
  assert.deepEqual(second.writes, first.writes, "the retry's response carries the same answer");
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "answered" }]);
});

test("one dead socket among an entry's responses does not end the hold; the last one does", () => {
  const { desk, terminals } = harness();
  const first = heldResponse();
  const second = heldResponse();
  desk.hold("session-a", ask(), askInput(), first.response, true);
  desk.hold("session-a", ask(), askInput(), second.response, true);

  first.close();
  assert.deepEqual(terminals, [], "a hold with a live response left is still a hold");

  desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } });
  assert.equal(second.writes.length, 1, "the surviving response is answered normally");
  assert.deepEqual(first.writes, [], "the dead one is left alone");
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "answered" }]);
});

test("a different ask from the same session replaces the hold, releasing the older one", () => {
  // The session has moved on, so the older hold is answering a question nobody is parked on.
  const { desk, terminals } = harness();
  const older = heldResponse();
  const newer = heldResponse();
  desk.hold("session-a", ask(), askInput(), older.response, true);
  assert.equal(desk.hold("session-a", ask("SECRET-a different question"), askInput("SECRET-a different question"), newer.response, true), true);

  assert.deepEqual(older.writes[0].body, {}, "the older hold is released, never answered");
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "released" }]);

  desk.resolve("session-a", { kind: "response", response: "SECRET-the new answer" });
  assert.deepEqual(
    (newer.writes[0].body as { hookSpecificOutput: { updatedInput: { questions: unknown } } })
      .hookSpecificOutput.updatedInput.questions,
    askInput("SECRET-a different question"),
    "the standing entry is the newer ask",
  );
});

test("at the cap a new hold is refused; a retry of a held ask still attaches", () => {
  const { desk, logged } = harness();
  for (let index = 0; index < MAX_HELD_QUESTIONS; index += 1) {
    assert.equal(
      desk.hold(`session-${String(index)}`, ask(), askInput(), heldResponse().response, true),
      true,
    );
  }

  const refused = heldResponse();
  assert.equal(
    desk.hold("session-over", ask(), askInput(), refused.response, true),
    false,
    "the newest is refused rather than the oldest released: the oldest is the one an operator has had longest to answer",
  );
  assert.deepEqual(refused.writes, [], "a refused response stays the caller's to answer");
  assert.ok(logged.some((line) => line.includes("refused a hold")), logged.join("\n"));

  // A session already held is not a new entry, so the cap does not apply to its retry.
  assert.equal(desk.hold("session-0", ask(), askInput(), heldResponse().response, true), true);
});

test("an entry takes a bounded number of retries; past the cap the repost is the caller's to answer", () => {
  // The retry attaches instead of creating an entry, so the host-wide cap cannot bound it: without
  // a per-entry ceiling a CLI reposting the same question would pin a socket per attempt for the
  // whole hold. The refusal direction matches the entry cap's: the newest attempt is answered
  // immediately, and the attempts already attached still get the answer.
  const { desk, logged } = harness();
  const attached: Array<ReturnType<typeof heldResponse>> = [];
  for (let index = 0; index < MAX_RESPONSES_PER_ENTRY; index += 1) {
    const attempt = heldResponse();
    attached.push(attempt);
    assert.equal(
      desk.hold("session-a", ask(), askInput(), attempt.response, true),
      true,
      `retry ${String(index)} attaches`,
    );
  }

  const over = heldResponse();
  assert.equal(
    desk.hold("session-a", ask(), askInput(), over.response, true),
    false,
    "past the cap the desk takes no further response for one ask",
  );
  assert.deepEqual(over.writes, [], "a refused response stays the caller's to answer");
  assert.ok(logged.some((line) => line.includes("refused a retry")), logged.join("\n"));

  desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } });
  for (const attempt of attached) {
    assert.equal(attempt.writes.length, 1, "every attached attempt is answered");
  }
});

test("a response already gone at the hold is registered nowhere, and the caller stays off it", () => {
  // A socket that died between the request arriving and the hold has nobody to answer: an entry
  // for it would watch for a close that already fired and squat its slot for the whole hold. The
  // true return is about the caller, not about a hold: every write to that response throws.
  const { desk, logged, terminals } = harness();
  const dead = heldResponse();
  dead.close();

  assert.equal(desk.hold("session-a", ask(), askInput(), dead.response, true), true);
  assert.deepEqual(dead.writes, [], "nothing is ever written to a dead response");
  assert.equal(desk.release("session-a"), false, "no entry was created");
  assert.deepEqual(terminals, [], "and no entry means no terminal state to report");
  assert.ok(logged.some((line) => line.includes("gone before the hold")), logged.join("\n"));

  const live = heldResponse();
  assert.equal(
    desk.hold("session-a", ask(), askInput(), live.response, true),
    true,
    "the dead response held no slot against the session's next ask",
  );
  desk.release("session-a");
  assert.deepEqual(live.writes[0].body, {});
});

test("a hold with no alert behind it creates nothing; a retry rides the entry's own alert", () => {
  // The alert and the hold answer the same question from two sides: a new entry with no alert
  // dispatched parks a session on a question the operator was never shown, and only the expiry
  // timer would ever end it. A retry attaching to a live entry is the opposite case: that entry's
  // alert is up, which is exactly why the tailer dropped the retry's duplicate.
  const { desk, logged } = harness();
  const unalerted = heldResponse();

  assert.equal(desk.hold("session-a", ask(), askInput(), unalerted.response, false), false);
  assert.deepEqual(unalerted.writes, [], "the refused response is answered by the caller");
  assert.ok(logged.some((line) => line.includes("alerted nowhere")), logged.join("\n"));

  const alerted = heldResponse();
  assert.equal(desk.hold("session-a", ask(), askInput(), alerted.response, true), true);
  const retry = heldResponse();
  assert.equal(
    desk.hold("session-a", ask(), askInput(), retry.response, false),
    true,
    "a retry of a live entry needs no alert of its own",
  );

  desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } });
  assert.equal(alerted.writes.length, 1);
  assert.deepEqual(retry.writes, alerted.writes, "both responses carry the one answer");
});

test("a digest-checked release ends only the ask it names", () => {
  // Both question paths share one delivery closure, so a failed delivery names a session and
  // nothing else. Keyed on the session alone, one ask's failure would release a different ask's
  // live, properly alerted hold; the digest is what tells the two apart.
  const { desk, logged } = harness();
  const held = heldResponse();
  desk.hold("session-a", ask(), askInput(), held.response, true);

  assert.equal(
    desk.release("session-a", questionDigest(ask("SECRET-a different question"))),
    false,
    "another ask's failed delivery leaves this hold standing",
  );
  assert.equal(held.writes.length, 0, "and writes nothing to it");
  assert.ok(logged.some((line) => line.includes("different ask")), logged.join("\n"));

  assert.equal(desk.release("session-a", questionDigest(ask())), true, "its own ask releases it");
  assert.deepEqual(held.writes[0].body, {});
  assert.equal(desk.release("session-b"), false, "a bare release still means whatever is held");
});

test("releaseAll waits for the released bodies to reach the wire, and no longer than its bound", async () => {
  // The shutdown ordering: the socket teardown that follows destroys connections, and a body still
  // buffered when its socket is destroyed is dropped, which the session sees as a connection reset
  // rather than the release. The wait is bounded so one stuck socket cannot hold shutdown open.
  const { desk, timers } = harness();
  const late = heldResponse();
  desk.hold("session-a", ask(), askInput(), late.response, true);

  let flushed = false;
  const shutdown = desk.releaseAll().then(() => {
    flushed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(late.writes[0].body, {}, "the body is written before anything is awaited");
  assert.equal(flushed, false, "shutdown waits while that body is still on its way out");

  late.finish();
  await shutdown;
  assert.equal(flushed, true, "and proceeds as soon as it lands");

  const stuck = heldResponse();
  desk.hold("session-b", ask(), askInput(), stuck.response, true);
  const bounded = desk.releaseAll();
  timers.fire();
  await bounded;
  assert.deepEqual(stuck.writes[0].body, {}, "a socket that never reports finished bounds the wait");
});

test("releaseAll answers every held entry {} under the shutdown state", () => {
  const { desk, terminals } = harness();
  const first = heldResponse();
  const second = heldResponse();
  desk.hold("session-a", ask(), askInput(), first.response, true);
  desk.hold("session-b", ask(), askInput(), second.response, true);

  desk.releaseAll();
  assert.deepEqual(first.writes[0].body, {});
  assert.deepEqual(second.writes[0].body, {});
  assert.deepEqual(
    terminals.map((entry) => entry.state),
    ["shutdown", "shutdown"],
  );
  assert.equal(desk.release("session-a"), false, "nothing is left held");
});

test("a throw out of the terminal-state notifier never crosses the response seam", () => {
  const { desk, logged } = harness({
    onTerminal: () => {
      throw new Error(`the editor quoting a question: ${QUESTION}`);
    },
  });
  const { response, writes } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);

  assert.doesNotThrow(() => desk.release("session-a"));
  assert.deepEqual(writes[0].body, {}, "the response is answered before the notifier runs");
  assert.ok(!logged.join("\n").includes("SECRET"), logged.join("\n"));
});

test("no log line ever carries question content, whatever the trigger", () => {
  const { desk, timers, logged } = harness();

  const answered = heldResponse();
  desk.hold("session-a", ask(), askInput(), answered.response, true);
  desk.resolve("session-a", { kind: "answers", answers: { [QUESTION]: "SECRET-Coffee" } });

  const expired = heldResponse();
  desk.hold("session-b", ask(), askInput(), expired.response, true);
  timers.fire();

  const gone = heldResponse();
  desk.hold("session-c", ask(), askInput(), gone.response, true);
  gone.close();

  const freeform = heldResponse();
  desk.hold("session-d", ask(), askInput(), freeform.response, true);
  desk.resolve("session-d", { kind: "response", response: "SECRET-typed reply" });

  desk.hold("session-e", ask(), askInput(), heldResponse().response, true);
  desk.releaseAll();

  assert.ok(logged.length > 0, "the triggers above are logged at all");
  assert.ok(!logged.join("\n").includes("SECRET"), logged.join("\n"));
});
