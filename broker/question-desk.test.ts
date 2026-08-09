// The question desk. Two properties carry the weight here: a held response resolves exactly once,
// whichever of the five triggers wins the race, and every failure direction lands on the release,
// so a lost hold costs the operator a console walk and never a question.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { AskedQuestion } from "./discord/render.ts";
import {
  MAX_CLOSED_ASKS,
  MAX_HELD_QUESTIONS,
  MAX_REPEAT_KEYS,
  MAX_RESPONSES_PER_ENTRY,
  createQuestionDesk,
} from "./question-desk.ts";
import type { QuestionTerminalDetail, QuestionTerminalState } from "./question-desk.ts";
import { MAX_INBOUND_TEXT_LENGTH } from "./routing/inbound.ts";
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
      options: [
        { label: "SECRET-Coffee", description: "SECRET-the classic" },
        { label: "SECRET-Tea", description: "SECRET-gentler" },
      ],
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

function harness(
  options: {
    onTerminal?: (sessionId: string, state: QuestionTerminalState) => void;
    now?: () => number;
  } = {},
) {
  const timers = fakeTimers();
  const logged: string[] = [];
  const terminals: Array<{ sessionId: string; state: QuestionTerminalState }> = [];
  const details: QuestionTerminalDetail[] = [];
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    log: (message) => logged.push(message),
    onTerminal:
      options.onTerminal ??
      ((sessionId, state, detail) => {
        terminals.push({ sessionId, state });
        details.push(detail);
      }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { desk, timers, logged, terminals, details };
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

test("an alert noted on an entry hands back the id its components are addressed by", () => {
  // The ordering the whole answer path rests on: the alert is posted before the hold exists, so the
  // id every component carries is handed back when the post's own round trip lands.
  const { desk } = harness();
  const { response } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);

  assert.equal(
    desk.noteAlert("session-a", questionDigest(ask("SECRET-a different question")), {
      threadId: "thread-1",
      messageId: "msg-1",
    }),
    null,
    "another ask's alert names an entry this session does not hold",
  );
  const entryId = desk.noteAlert("session-a", questionDigest(ask()), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);
  assert.equal(desk.noteAlert("session-b", questionDigest(ask()), {
    threadId: "thread-1",
    messageId: "msg-1",
  }), null, "a session holding nothing has no entry to note an alert on");

  const entry = desk.entry(entryId);
  assert.deepEqual(entry?.alert, { threadId: "thread-1", messageId: "msg-1" });
  assert.equal(entry?.sessionId, "session-a");
  assert.deepEqual(entry?.selections, [[]], "one empty selection per question in the ask");
});

test("an entry id is unguessable, unique per entry, and dead the moment the hold ends", () => {
  const { desk } = harness();
  const ids = new Set<string>();
  for (let index = 0; index < 8; index += 1) {
    const session = `session-${String(index)}`;
    desk.hold(session, ask(), askInput(), heldResponse().response, true);
    const id = desk.noteAlert(session, questionDigest(ask()), {
      threadId: "thread-1",
      messageId: `msg-${String(index)}`,
    });
    assert.ok(id !== null);
    assert.match(id, /^[0-9a-f]{12}$/, "an opaque token, derived from nothing about the ask");
    ids.add(id);
  }
  assert.equal(ids.size, 8, "no two entries share an id");

  const [first] = [...ids];
  desk.release("session-0");
  assert.equal(desk.entry(first), null, "a released entry's id names nothing");
  assert.equal(desk.releaseEntry(first), false);
  assert.deepEqual(desk.submit(first), { kind: "gone" });
  assert.equal(desk.select(first, 0, [0]), null);
});

test("every terminal state carries the ask's own message and what was submitted", () => {
  // The message-edit seam: the editor is handed where the alert landed, the ask it drew, and the
  // answers to render, because a message that resolved has to say so and drop its components.
  const { desk, timers, details } = harness();
  const answered = heldResponse();
  desk.hold("session-a", ask(), askInput(), answered.response, true);
  desk.noteAlert("session-a", questionDigest(ask()), { threadId: "thread-1", messageId: "msg-1" });
  const answers = { [QUESTION]: "SECRET-Coffee" };
  desk.resolve("session-a", { kind: "answers", answers });

  assert.equal(details.length, 1);
  assert.deepEqual(details[0].alert, { threadId: "thread-1", messageId: "msg-1" });
  assert.deepEqual(details[0].questions, ask());
  assert.deepEqual(details[0].answers, { kind: "answers", answers });

  // Every release state carries the same detail with no answers: the message still has to be
  // rewritten, and what it says is that the console has the question now.
  const expired = heldResponse();
  desk.hold("session-b", ask(), askInput(), expired.response, true);
  desk.noteAlert("session-b", questionDigest(ask()), { threadId: "thread-2", messageId: "msg-2" });
  timers.fire();
  assert.deepEqual(details[1].alert, { threadId: "thread-2", messageId: "msg-2" });
  assert.equal(details[1].answers, null);

  // An entry whose alert never landed reports a null alert rather than a guess: there is no
  // message to edit, and inventing one would rewrite something else in the thread.
  const unposted = heldResponse();
  desk.hold("session-c", ask(), askInput(), unposted.response, true);
  unposted.close();
  assert.equal(details[2].alert, null);
});

test("a select records what the ask offered, and Send answers in the measured vocabulary", () => {
  // The desk's half of the answer path: positions in, labels out, and the map keyed by the exact
  // question text the payload carried.
  const { desk } = harness();
  const multi: AskedQuestion[] = [
    ...ask(),
    {
      question: "SECRET-which sections?",
      header: "Sections",
      multiSelect: true,
      options: [
        { label: "SECRET-Desk", description: null },
        { label: "SECRET-Message", description: null },
      ],
    },
  ];
  const { response, writes } = heldResponse();
  desk.hold("session-a", multi, askInput(), response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(multi), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);

  assert.deepEqual(desk.submit(entryId), { kind: "incomplete", questionNumber: 1 });
  desk.select(entryId, 0, [1]);
  assert.deepEqual(desk.submit(entryId), { kind: "incomplete", questionNumber: 2 });
  desk.select(entryId, 1, [0, 1]);
  // The last report of a question replaces the one before it: a select reports its whole selection
  // on every change.
  desk.select(entryId, 1, [1]);

  assert.deepEqual(desk.submit(entryId), { kind: "answered" });
  assert.deepEqual(
    (writes[0].body as { hookSpecificOutput: { updatedInput: { answers: unknown } } })
      .hookSpecificOutput.updatedInput.answers,
    { [QUESTION]: "SECRET-Tea", "SECRET-which sections?": "SECRET-Message" },
  );
});

test("a multi-select answer joins its labels the way the console picker joins them", () => {
  // Measured from one session's transcript carrying both paths for one question: submitted as an
  // array of labels the ask reaches the model as "Jalapeños,Mushrooms,Pepperoni", while the console
  // picker's own answer to the same question arrives as "Jalapeños, Mushrooms, Pepperoni". Both
  // answer correctly, so what the join buys is that a session cannot tell which surface answered it.
  //
  // A label containing a comma is ambiguous in this format: the session reads one separator where
  // the operator picked two labels. That ambiguity is the console's own, and it is inherited on
  // purpose rather than guarded against, because a surface that escaped or quoted such a label would
  // be back to producing text no console answer produces, which is the whole difference being closed.
  const { desk } = harness();
  const toppings: AskedQuestion[] = [
    {
      question: "SECRET-which toppings?",
      header: "Toppings",
      multiSelect: true,
      options: [
        { label: "Jalapeños", description: null },
        { label: "Mushrooms", description: null },
        { label: "Pepperoni", description: null },
      ],
    },
  ];
  const { response, writes } = heldResponse();
  desk.hold("session-a", toppings, askInput(), response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(toppings), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);

  desk.select(entryId, 0, [0, 1, 2]);
  assert.deepEqual(desk.submit(entryId), { kind: "answered" });
  assert.deepEqual(
    (writes[0].body as { hookSpecificOutput: { updatedInput: { answers: unknown } } })
      .hookSpecificOutput.updatedInput.answers,
    { "SECRET-which toppings?": "Jalapeños, Mushrooms, Pepperoni" },
    "the console's measured text, not the array's bare-comma rendering",
  );
});

test("a single-select answer still carries a bare label and a typed answer still replaces the map", () => {
  // The two shapes the join leaves alone. A single-select answer is one label, never a one-element
  // join, and a free-form answer replaces the per-question answers entirely with `response`.
  const { desk } = harness();
  const single = heldResponse();
  desk.hold("session-a", ask(), askInput(), single.response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(ask()), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);
  desk.select(entryId, 0, [0]);
  assert.deepEqual(desk.submit(entryId), { kind: "answered" });
  const updated = (
    single.writes[0].body as {
      hookSpecificOutput: { updatedInput: { answers?: unknown; response?: unknown } };
    }
  ).hookSpecificOutput.updatedInput;
  assert.deepEqual(updated.answers, { [QUESTION]: "SECRET-Coffee" });

  const typed = heldResponse();
  desk.hold("session-b", ask(), askInput(), typed.response, true);
  desk.noteAlert("session-b", questionDigest(ask()), { threadId: "thread-2", messageId: "msg-2" });
  assert.equal(desk.answerTyped("session-b", "SECRET-neither, tea"), true);
  const replaced = (
    typed.writes[0].body as {
      hookSpecificOutput: { updatedInput: { answers?: unknown; response?: unknown } };
    }
  ).hookSpecificOutput.updatedInput;
  assert.equal(replaced.answers, undefined, "a free-form answer carries no answers map");
  assert.equal(replaced.response, "SECRET-neither, tea");
});

test("the refused-retry line is rate-limited, unlike every other line here", () => {
  // A CLI retrying past the per-entry cap posts for the life of a four-hour hold, and one line an
  // attempt would push every other line out of the log through rotation.
  let at = 1_000;
  const { desk, logged } = harness({ now: () => at });
  for (let index = 0; index < MAX_RESPONSES_PER_ENTRY; index += 1) {
    desk.hold("session-a", ask(), askInput(), heldResponse().response, true);
  }

  for (let index = 0; index < 5; index += 1) {
    assert.equal(desk.hold("session-a", ask(), askInput(), heldResponse().response, false), false);
  }
  assert.equal(
    logged.filter((line) => line.includes("refused a retry")).length,
    1,
    "the first is written at once and the rest of the window is counted",
  );

  at += 60_000;
  assert.equal(desk.hold("session-a", ask(), askInput(), heldResponse().response, false), false);
  assert.ok(
    logged.some((line) => line.includes("occurred 4 more time(s)")),
    logged.join("\n"),
  );
});

test("a question asked as a prototype key answers under its own key", () => {
  // Question text is untrusted conversation content and the answers map is keyed by it verbatim, so
  // `__proto__` is a key every plain object already answers with its prototype: assigned onto one,
  // the answer becomes no property at all and the session is handed a map missing the question it
  // asked.
  const { desk } = harness();
  const proto = ask("__proto__");
  const { response, writes } = heldResponse();
  desk.hold("session-a", proto, askInput("__proto__"), response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(proto), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);

  desk.select(entryId, 0, [0]);
  assert.deepEqual(desk.submit(entryId), { kind: "answered" });

  const answers = (
    writes[0].body as { hookSpecificOutput: { updatedInput: { answers: Record<string, unknown> } } }
  ).hookSpecificOutput.updatedInput.answers;
  assert.ok(Object.hasOwn(answers, "__proto__"), JSON.stringify(answers));
  assert.equal(Object.getOwnPropertyDescriptor(answers, "__proto__")?.value, "SECRET-Coffee");
});

test("an entry already carrying an alert keeps the message its components live on", () => {
  // A second delivery for the same ask (the tailer's resolution-time yield racing the hook's own
  // alert inside the digest window) would otherwise repoint the entry at its newer notice, and the
  // terminal state would rewrite that one while the first message kept live components forever.
  const { desk } = harness();
  const { response } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);
  const digest = questionDigest(ask());

  const first = desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-1" });
  assert.ok(first !== null);
  assert.equal(
    desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-2" }),
    null,
    "the second alert names no entry to draw on: this one is already drawn",
  );
  assert.deepEqual(desk.entry(first)?.alert, { threadId: "thread-1", messageId: "msg-1" });
});

test("a typed answer resolves the ask as response, but only once the thread has the message", () => {
  // The window between the hold and its alert landing is one Discord round trip, and in it the
  // thread shows nothing about this ask: a message typed there is about something else, and
  // answering the session with it would inject words nobody aimed at the question.
  const { desk, terminals } = harness();
  const { response, writes } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);

  assert.equal(
    desk.answerTyped("session-a", "SECRET-in my own words"),
    false,
    "an ask with no message in the thread is not answered by a message in the thread",
  );
  assert.equal(writes.length, 0, "and the hold stands, untouched");

  desk.noteAlert("session-a", questionDigest(ask()), { threadId: "thread-1", messageId: "msg-1" });
  assert.equal(desk.answerTyped("session-a", "SECRET-in my own words"), true);
  assert.deepEqual(writes[0].body, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions: askInput(), response: "SECRET-in my own words" },
    },
  });
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "answered" }]);

  assert.equal(
    desk.answerTyped("session-a", "SECRET-and again"),
    false,
    "the ask is answered, so the next message is the operator's to steer with",
  );
});

test("a typed answer is bounded by this desk, not by whoever hands it over", () => {
  // The seam where untrusted text enters a session's own tool result, so the bound is here and not
  // only at the router that read the message off Discord: invisibles that would show the thread and
  // the transcript two different answers are stripped, and the cut is on code points, over the same
  // ceiling the inbound path spends.
  const { desk } = harness();
  const { response, writes } = heldResponse();
  desk.hold("session-a", ask(), askInput(), response, true);
  desk.noteAlert("session-a", questionDigest(ask()), { threadId: "thread-1", messageId: "msg-1" });

  const typed = `  SECRET-yes,‮ go\u{1f600}${"x".repeat(MAX_INBOUND_TEXT_LENGTH)}  `;
  assert.equal(desk.answerTyped("session-a", typed), true);
  const answered = (writes[0].body as { hookSpecificOutput: { updatedInput: { response: string } } })
    .hookSpecificOutput.updatedInput.response;
  assert.equal([...answered].length, MAX_INBOUND_TEXT_LENGTH, "cut on code points, at the ceiling");
  assert.ok(answered.startsWith("SECRET-yes, go\u{1f600}"), answered.slice(0, 40));
  assert.ok(!answered.includes("‮"), "the invisible class never reaches the tool result");
});

test("the hold-stands line a console report writes is rate-limited", () => {
  // Transcript lines drive this refusal, and a poll reads every line a session wrote since the last
  // one: unlimited, it would push the rest of the log out through rotation far faster than the
  // per-post lines around it can.
  let at = 1_000;
  const { desk, logged } = harness({ now: () => at });
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), heldResponse().response, true);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(desk.answeredAtConsole("session-a", digest), false);
  }
  assert.equal(
    logged.filter((line) => line.includes("the hold stands")).length,
    1,
    "the first is written at once and the rest of the window is counted",
  );

  at += 60_000;
  assert.equal(desk.answeredAtConsole("session-a", digest), false);
  assert.ok(
    logged.some((line) => line.includes("occurred 4 more time(s)")),
    logged.join("\n"),
  );
});

test("a console answer after a release flips the message exactly once", () => {
  // The release tells the operator to answer at the console; the transcript's resolution line is
  // that answer arriving, minutes or hours later, with the entry long gone. What the flip reaches
  // is the record of the ask, which names the message the release already rewrote.
  const { desk, terminals, details } = harness();
  const { response } = heldResponse();
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), response, true);
  const entryId = desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-1" });
  desk.release("session-a");

  assert.equal(desk.answeredAtConsole("session-a", digest), true);
  assert.deepEqual(terminals, [
    { sessionId: "session-a", state: "released" },
    { sessionId: "session-a", state: "answered-at-console" },
  ]);
  assert.deepEqual(details[1], {
    entryId,
    alert: { threadId: "thread-1", messageId: "msg-1" },
    questions: ask(),
    answers: null,
  });

  assert.equal(
    desk.answeredAtConsole("session-a", digest),
    false,
    "the record is consumed by the flip, so a second report edits nothing",
  );
  assert.equal(terminals.length, 2);
});

test("an ask answered from the thread is never also reported answered at the console", () => {
  // The tool call proceeds and writes its transcript line on this path too, so the report arrives
  // for an ask whose message already renders what the operator sent. Nothing was left waiting at a
  // console, so nothing is remembered for one to answer.
  const { desk, terminals } = harness();
  const { response } = heldResponse();
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), response, true);
  desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-1" });
  desk.answerTyped("session-a", "SECRET-in my own words");

  assert.equal(desk.answeredAtConsole("session-a", digest), false);
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "answered" }]);
});

test("a console answer naming an ask still held leaves that hold standing", () => {
  // A held PreToolUse response blinds the console, so no picker rendered for this ask and nothing
  // there can have answered it. The report is refused rather than resolving a live hold, which is
  // the direction every uncertainty here takes.
  const { desk, terminals } = harness();
  const { response, writes } = heldResponse();
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), response, true);
  desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-1" });

  assert.equal(desk.answeredAtConsole("session-a", digest), false);
  assert.deepEqual(terminals, []);
  assert.deepEqual(writes, [], "the hold is still held and still answerable");
  assert.equal(desk.answerTyped("session-a", "SECRET-in my own words"), true);
});

test("two closed instances of one ask flip in the order their console answers landed", () => {
  // A session that asks the same question twice, both released, leaves two messages in the thread
  // saying the console has it. Claude Code writes a resolution line per ask, in the order the
  // console answered them, so the first line is the first message's: matching the newest record
  // instead would flip the second message and leave the answered one still asking for a walk to a
  // console that has nothing on it.
  const { desk, terminals, details } = harness();
  const digest = questionDigest(ask());
  const closed: Array<string | null> = [];
  for (const messageId of ["msg-1", "msg-2"]) {
    desk.hold("session-a", ask(), askInput(), heldResponse().response, true);
    closed.push(desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId }));
    desk.release("session-a");
  }

  assert.equal(desk.answeredAtConsole("session-a", digest), true);
  assert.equal(desk.answeredAtConsole("session-a", digest), true);
  assert.deepEqual(
    details.slice(2).map((detail) => detail.alert?.messageId),
    ["msg-1", "msg-2"],
    "oldest first: the first answer closes the message the first ask left standing",
  );
  assert.deepEqual(
    details.slice(2).map((detail) => detail.entryId),
    closed,
  );
  assert.deepEqual(
    terminals.map((terminal) => terminal.state),
    ["released", "released", "answered-at-console", "answered-at-console"],
  );
  assert.equal(
    desk.answeredAtConsole("session-a", digest),
    false,
    "and both records are spent, so a third line edits nothing",
  );
});

test("an ask asked again and held still flips the message its closed instance left standing", () => {
  // The transcript is polled on an interval, so a console answer reaches this desk seconds after the
  // session it unparked has moved on, and a session that re-asks inside that window holds the same
  // digest the line names. The live hold cannot be what the line reports: no picker renders under a
  // hold, so the line belongs to the closed instance and its message is the one that stops saying
  // the console has it.
  const { desk, terminals, details } = harness();
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), heldResponse().response, true);
  const closed = desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-1" });
  desk.release("session-a");
  const live = heldResponse();
  desk.hold("session-a", ask(), askInput(), live.response, true);
  desk.noteAlert("session-a", digest, { threadId: "thread-1", messageId: "msg-2" });

  assert.equal(desk.answeredAtConsole("session-a", digest), true);
  assert.equal(details.at(-1)?.entryId, closed);
  assert.deepEqual(details.at(-1)?.alert, { threadId: "thread-1", messageId: "msg-1" });
  assert.deepEqual(live.writes, [], "and the ask the session is parked on is untouched");
  assert.deepEqual(
    terminals.map((terminal) => terminal.state),
    ["released", "answered-at-console"],
  );
  assert.equal(
    desk.answeredAtConsole("session-a", digest),
    false,
    "with the record spent, the live hold is all that is left and it stands",
  );
});

test("a hold released before its alert landed remembers nothing to flip", () => {
  // The ask this thread cannot answer faithfully: it is released before any message is noted on the
  // entry, so the notice already in the thread stands as the alert it is and there is nothing for a
  // console answer to rewrite.
  const { desk, terminals } = harness();
  const { response } = heldResponse();
  const digest = questionDigest(ask());
  desk.hold("session-a", ask(), askInput(), response, true);
  desk.release("session-a");

  assert.equal(desk.answeredAtConsole("session-a", digest), false);
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "released" }]);
});

test("the closed-ask record is bounded, and the oldest is what falls out of it", () => {
  // The record holds question text, so it is bounded the way everything else here is. Past the
  // bound the cost is a message left reading "answer it at the console" for a question already
  // answered, never a lost question.
  const { desk } = harness();
  const asks = Array.from({ length: MAX_CLOSED_ASKS + 1 }, (_value, index) =>
    ask(`SECRET-question ${String(index)}`),
  );
  for (const [index, asked] of asks.entries()) {
    const session = `session-${String(index)}`;
    desk.hold(session, asked, askInput(), heldResponse().response, true);
    desk.noteAlert(session, questionDigest(asked), {
      threadId: "thread-1",
      messageId: `msg-${String(index)}`,
    });
    desk.release(session);
  }

  assert.equal(
    desk.answeredAtConsole("session-0", questionDigest(asks[0])),
    false,
    "the oldest record was evicted by the newest",
  );
  assert.equal(
    desk.answeredAtConsole("session-1", questionDigest(asks[1])),
    true,
    "and everything inside the bound still flips",
  );
  assert.equal(
    desk.answeredAtConsole(
      `session-${String(MAX_CLOSED_ASKS)}`,
      questionDigest(asks[MAX_CLOSED_ASKS]),
    ),
    true,
  );
});

test("a console answer naming a different ask than the record holds flips nothing", () => {
  // The digest is what names an ask across the tailer and this desk. A session that asked twice
  // must not have the wrong message flipped by the resolution of the other one.
  const { desk, terminals } = harness();
  desk.hold("session-a", ask(), askInput(), heldResponse().response, true);
  desk.noteAlert("session-a", questionDigest(ask()), { threadId: "thread-1", messageId: "msg-1" });
  desk.release("session-a");

  assert.equal(desk.answeredAtConsole("session-a", questionDigest(ask("SECRET-another"))), false);
  assert.equal(desk.answeredAtConsole("session-b", questionDigest(ask())), false);
  assert.deepEqual(terminals, [{ sessionId: "session-a", state: "released" }]);
});

test("the repeat-log map stays bounded even when every reason still owes a count", () => {
  // The reasons carry session ids, so a session that trips the response cap twice and goes away
  // leaves an entry owing a count that only another call for that same session would ever flush.
  // Swept oldest-first once the map is over its bound, and the owed count rides out with the key.
  let at = 1_000;
  const { desk, logged } = harness({ now: () => at });
  const trip = (session: string): void => {
    for (let index = 0; index <= MAX_RESPONSES_PER_ENTRY; index += 1) {
      desk.hold(session, ask(), askInput(), heldResponse().response, true);
    }
    // Twice past the cap: the first refusal is written and the second is counted against the
    // window, which is the state that pins an entry in the map.
    desk.hold(session, ask(), askInput(), heldResponse().response, true);
    desk.release(session);
  };
  for (let index = 0; index <= MAX_REPEAT_KEYS; index += 1) trip(`session-${String(index)}`);

  // Every window is closed by now, so the sweep the last reason triggers has the whole map to
  // choose from, and it takes the oldest.
  at += 60_000;
  trip("session-last");

  assert.ok(
    logged.some((line) => line.includes("session-0,") && line.includes("occurred 1 more time(s)")),
    "the swept key's owed count is flushed rather than dropped with it",
  );
  const before = logged.length;
  trip("session-0");
  assert.deepEqual(
    logged.slice(before).filter((line) => line.includes("session-0,") && line.includes("occurred")),
    [],
    "session-0 is gone from the map, so its next refusal opens a fresh window owing nothing",
  );
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

  // The two refusals the typed and console paths speak: a hold with no message in the thread yet,
  // and a console answer naming an ask still held.
  const typed = heldResponse();
  desk.hold("session-f", ask(), askInput(), typed.response, true);
  desk.answerTyped("session-f", "SECRET-typed too early");
  desk.answeredAtConsole("session-f", questionDigest(ask()));

  desk.hold("session-e", ask(), askInput(), heldResponse().response, true);
  desk.releaseAll();

  assert.ok(logged.length > 0, "the triggers above are logged at all");
  assert.ok(!logged.join("\n").includes("SECRET"), logged.join("\n"));
});
