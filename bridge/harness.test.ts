// The turn state machine, driven end to end against a stand-in runtime.
//
// Everything here runs against `fake-dsh.ts` over the real SDK client and a real child process, so
// the wire, the subscription and the teardown ladder are the production ones and only the worker is
// not. Nothing touches Qwen, a port, the operator's harness home, or the real state file: each test
// owns a temp directory holding both its state file and its harness home.
//
// The failures these guard are the ones nobody sees happen. A turn whose answer never arrives looks
// exactly like a worker still thinking, and a turn whose answer arrives twice looks like the
// operator being told the same thing twice for no reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Bridge,
  MAX_PATH_LENGTH,
  MAX_RETAINED_FILES,
  MAX_STATE_BYTES,
  MAX_STATE_DIAGNOSTICS,
  closeAll,
  defaultScope,
  dshRuntimeSpec,
  insideStateDirectory,
  noteFile,
  readState,
  recordFilePath,
  releaseState,
  workspacePath,
  writeState,
} from "./harness.ts";
import type { BridgeOptions, SessionRecord, TouchedFiles } from "./harness.ts";
import { MAX_STATUS_LOG_BYTES } from "./log.ts";
import { MAX_CHANNEL_CONTENT, MAX_META_FILES, MAX_SESSION_NAME } from "./protocol.ts";
import type { ChannelNotification } from "./protocol.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-dsh.ts");
/** The capture of a real run: two steps, one `write` tool call, and a turn that completes. */
const RUN = path.join(HERE, "fixtures", "sdk-run-1.jsonl");
/** The shorter capture: one step, no tool call. */
const SHORT_RUN = path.join(HERE, "fixtures", "sdk-run-2.jsonl");

/** How long a test waits for something the stand-in has to produce before calling it a failure. */
const PATIENCE_MS = 20_000;

/** What the bridge hands a turn-end listener: the finished turn with the worker's answer uncut. */
type TurnEnd = Parameters<NonNullable<BridgeOptions["onTurnEnd"]>>[0];

interface Stand {
  readonly bridge: Bridge;
  readonly pushed: ChannelNotification[];
  /** Every finished turn the bridge handed its turn-end listener, in order. */
  readonly ended: TurnEnd[];
  readonly logged: string[];
  /** A workspace path for a prompt. Absolute and this test's own. */
  readonly workspace: string;
  readonly stateFile: string;
  /** How many replays the stand-in has finished, which it appends a line per replay to say. */
  readonly replays: () => number;
  /**
   * Register a bridge a test built over this stand's directory, so the one hook closes it before the
   * directory goes. Returns the bridge, so a construction can be wrapped in place.
   */
  readonly own: <B extends { close: () => Promise<void> }>(bridge: B) => B;
}

/** A bridge whose runtime is the stand-in, with state and harness home in a directory of its own. */
function stand(
  t: { after: (fn: () => void | Promise<void>) => void },
  args: readonly string[] | ((dir: string) => readonly string[]) = [],
  fixture = RUN,
  over: { requestTimeoutMs?: number; promptTimeoutMs?: number; push?: (notification: ChannelNotification) => void } = {},
): Stand {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-"));
  // The stand-in's flags may name a path inside this stand's own directory, which exists only now.
  const flags = typeof args === "function" ? args(dir) : args;
  const pushed: ChannelNotification[] = [];
  const ended: TurnEnd[] = [];
  const logged: string[] = [];
  const stateFile = path.join(dir, "state", "sessions.json");
  // The stand-in appends one line here per replay it finishes. A replay that ends without an idle
  // status ends with no signal of its own, and this is what a test waits on instead of waiting for
  // the stream to look quiet, which measures the machine's load rather than the runtime.
  const doneFile = path.join(dir, "replays.log");
  const bridge = new Bridge({
    stateFile,
    scope: dir,
    home: path.join(dir, "home"),
    runtime: {
      command: process.execPath,
      args: [FAKE, fixture, "--done-file", doneFile, ...flags],
      env: process.env,
      requestTimeoutMs: over.requestTimeoutMs ?? PATIENCE_MS,
      ...(over.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: over.promptTimeoutMs }),
    },
    provider: "fake-provider",
    model: "fake-model",
    push: (notification) => {
      pushed.push(notification);
      over.push?.(notification);
    },
    onTurnEnd: (turn) => {
      ended.push(turn);
    },
    log: (line) => logged.push(line),
  });
  // One hook closes every bridge the test built over this directory and then removes it. A successor
  // closed at the end of a test body is not closed when an assertion before that line fails, and its
  // child then holds the directory the removal is about to take; a list one hook drains puts the
  // ordering in one place rather than in each test.
  const owned: { close: () => Promise<void> }[] = [bridge];
  t.after(async () => {
    for (const one of owned) await one.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const own = <B extends { close: () => Promise<void> }>(other: B): B => {
    owned.push(other);
    return other;
  };
  const replays = (): number =>
    existsSync(doneFile) ? readFileSync(doneFile, "utf8").split("\n").filter((line) => line.trim() !== "").length : 0;
  return { bridge, pushed, ended, logged, workspace: dir, stateFile, replays, own };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + PATIENCE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The meta of the one event a test expects, with a readable failure when there is not exactly one. */
function onlyEvent(pushed: readonly ChannelNotification[]): ChannelNotification["params"] {
  assert.equal(pushed.length, 1, `expected one channel event, got ${String(pushed.length)}`);
  return pushed[0].params;
}

test("a prompt returns while the worker is still streaming and its finished turn arrives as one event", async (t) => {
  // The whole point of the bridge: the call returns a receipt at once and the answer arrives later,
  // by itself. A bridge that waited for the turn would be the file-polling loop it replaces.
  //
  // This is section 2's second acceptance criterion: against the fake, dsh_prompt returns with the
  // session id and the turn number while the fake is still streaming, and returns before any
  // channel push for that turn. The criterion is that ordering, and there is no timing assertion
  // here: a wall-clock bound measures the load on the machine running the suite rather than whether
  // the receipt waited on the worker, so none belongs here.
  const { bridge, pushed, workspace } = stand(t, ["--delay", "25"]);

  const receipt = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });

  // The ordering is the property, and it holds whatever the machine's load is: the stand-in answers
  // the prompt before it streams a thing, so a receipt that arrived with nothing pushed and the
  // session busy is a receipt that returned ahead of the work. A wall-clock bound here would be
  // measuring a cold process spawn against a shared machine instead.
  assert.match(receipt.sessionId, /^session-[0-9a-f]{32}$/, "the id is the SDK's own, never one invented here");
  assert.equal(receipt.turn, 1);
  assert.equal(pushed.length, 0, "the turn is still streaming, so nothing has been pushed");
  assert.deepEqual(bridge.busy(), { busy: true, sessions: ["builder"] });

  await until(() => pushed.length > 0, "the turn to end");
  const event = onlyEvent(pushed);
  assert.equal(event.meta.session, "builder");
  assert.equal(event.meta.kind, "turn_end");
  assert.equal(event.meta.turn, "1");
  assert.equal(event.meta.finish_reason, "completed");
  // Derived from the turn's own tool calls: the capture writes one file and runs no command.
  assert.equal(event.meta.files_touched, "hello-from-qwen.txt");
  assert.equal(event.meta.commands_run, "0");
  assert.match(event.content, /hello-from-qwen\.txt/, "the content is the worker's own last answer");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] });
});

test("an idle for a session nobody prompted, and a second idle for a turn already ended, push nothing", async (t) => {
  // Both are absence assertions. The stand-in writes the foreign idle from inside the replay,
  // immediately after the receipt that confirms this turn, which is the first moment the bridge has
  // subscribed, registered a turn and adopted it: a frame written at the handshake instead reaches
  // a client with no subscriptions and is dropped, so a green here would be about a notification
  // the bridge never saw. The test below is the coverage half, driving the same frame at the same
  // point with this bridge's own session id and watching it end the turn.
  //
  // Every wait here is on the bridge's own side of the boundary rather than the stand-in's. The
  // replay counter says the stand-in finished writing; `pushed` says the bridge finished reading,
  // and an assertion about `pushed` taken off the writer's marker is one that reads the consumer
  // through a window that closes under load. The second turn is what makes the absence honest: the
  // notifications are one ordered stream, so a stray push from the first turn arrives before the
  // second turn's own and this count catches it.
  const { bridge, pushed, workspace, replays } = stand(t, ["--foreign-idle", "--extra-idle"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length >= 1, "the first turn to end");
  await until(() => replays() >= 1, "the first replay to end, extra idle and all");

  assert.equal(pushed[0].params.meta.kind, "turn_end", "the foreign idle mid-turn did not end this one");
  assert.match(pushed[0].params.content, /hello-from-qwen\.txt/, "and the answer is the whole of the turn's own text");

  const second = await bridge.prompt({ session: "builder", text: "and again", cwd: workspace });
  assert.equal(second.turn, 2);
  await until(() => pushed.length >= 2, "the second turn to end");

  assert.equal(pushed.length, 2, "a real second turn does push, so the count above was not stuck");
  assert.equal(pushed[1].params.meta.kind, "turn_end", "and the event behind it is that turn's own");
  assert.equal(pushed[1].params.meta.turn, "1", "the turn number is the runtime's own, read from turn/start");
});

test("an idle at that same point naming this bridge's own session does end the turn", async (t) => {
  // The control for the absence above, and the reason it is coverage rather than an instrument
  // that functions: the same notification, written at the same place in the same replay, matched by
  // the bridge on the session id it carries rather than on anything the test handed the stand-in.
  // Its arrival is observable here, which is what says the ignored one arrived too.
  const { bridge, pushed, workspace, replays } = stand(t, ["--own-idle"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the idle at that point to end the turn");

  assert.equal(pushed[0].params.meta.kind, "error", "a turn ended before its own turn/end is not a completion");
  assert.equal(pushed[0].params.meta.finish_reason, "unknown");
  await until(() => replays() >= 1, "the replay to end");
  assert.equal(pushed.length, 1, "and the turn's own later idle finds no turn left to end");
});

test("a turn the runtime failed reaches the model as an error rather than as an answer", async (t) => {
  // `session.status` has two values and neither of them is an error, so a failed turn is one that
  // goes idle like any other. What it ended for is in its own turn/end event, and a bridge that did
  // not read it would report a failure as an ordinary answer with an empty body.
  const { bridge, pushed, workspace } = stand(t, ["--reason", "error"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "error");
  assert.equal(event.meta.finish_reason, "error");
});

test("a turn that ended for any reason but completion is an error, not an answer", async (t) => {
  // The reason is a sum type of six variants and only one of them is a completion. `blocked` is
  // live under the approval policy this bridge presets, and a variant added upstream lands here
  // too: reported as an ordinary turn end it would reach the model as an answer whose body happens
  // to be empty, which reads as a worker that had nothing to say.
  const { bridge, pushed, workspace } = stand(t, ["--reason", "blocked"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "error");
  assert.equal(event.meta.finish_reason, "blocked", "the runtime's own word is carried whatever the kind is");
});

test("a kill during a turn reports the turn as killed, carrying what the worker had already said", async (t) => {
  const { bridge, pushed, workspace, replays } = stand(t, ["--stop-before-idle"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  // The replay carries no idle under this flag, so it ends with no signal of its own; the stand-in
  // says when it is done rather than the test inferring it from a gap between notifications.
  await until(() => replays() >= 1, "the replay to end");
  assert.equal(bridge.busy().busy, true, "with no idle status the turn is still in flight");
  assert.equal(pushed.length, 0);

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, ["builder"]);
  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "killed");
  assert.equal(event.meta.finish_reason, "killed");
  assert.match(event.content, /hello-from-qwen\.txt/, "the last text the turn committed, not an empty string");
  assert.equal(bridge.busy().busy, false);
});

test("a kill with nothing in flight reports nothing at all", async (t) => {
  // The absence half of the pair above, on the same counter and the same push path: the test before
  // this one is its control, since the two differ only in whether a turn was running.
  const { bridge, pushed, workspace, replays } = stand(t);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");
  await until(() => replays() >= 1, "the replay to end");

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, [], "no turn was in flight, so none was killed");
  assert.equal(pushed.length, 1, "the turn's own event and nothing for the kill");
});

test("one worker serves one workspace, and the binding is released by a kill", async (t) => {
  const { bridge, pushed, workspace } = stand(t);
  const elsewhere = path.join(workspace, "elsewhere");
  mkdirSync(elsewhere);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  // A name pointed somewhere else and a new name pointed somewhere else are both refused, and for
  // different reasons: a known name's workspace is fixed for the life of its conversation, while a
  // new name is refused only for as long as this bridge's one runtime is bound to another place.
  await assert.rejects(
    bridge.prompt({ session: "builder", text: "over here instead", cwd: elsewhere }),
    (error: Error) => error.message.includes(workspace) && /workspace is fixed/.test(error.message),
    "a known session named with a second workspace must be refused",
  );
  await assert.rejects(
    bridge.prompt({ session: "another", text: "over here instead", cwd: elsewhere }),
    (error: Error) => error.message.includes(workspace) && error.message.includes("dsh_kill"),
    "a new session in a second workspace must be refused while the worker runs",
  );
  await assert.rejects(
    bridge.prompt({ session: "fresh", text: "no workspace named" }),
    /needs its cwd/,
    "a new session with no cwd at all is refused too",
  );

  await bridge.kill("builder");
  const receipt = await bridge.prompt({ session: "another", text: "over here instead", cwd: elsewhere });

  assert.match(receipt.sessionId, /^session-/, "with the worker gone, another workspace is accepted");
});

test("a remembered session keeps its workspace across a kill and across a restart", async (t) => {
  // Acceptance criterion 5 is about the workspace remembered for the name, not about the workspace
  // the runtime happens to be bound to. A bridge that checked only the binding would accept the new
  // path once the child was gone and quietly replace the session id, which abandons the very
  // conversation the state file exists to preserve, with nothing but a log line to say so.
  const { bridge, pushed, workspace, stateFile, own } = stand(t);
  const elsewhere = path.join(workspace, "elsewhere");
  mkdirSync(elsewhere);

  const first = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");
  await bridge.kill("builder");

  await assert.rejects(
    bridge.prompt({ session: "builder", text: "over here instead", cwd: elsewhere }),
    /workspace is fixed/,
    "with no runtime bound at all, the workspace the name was created in is still the answer",
  );

  // A different Bridge over the same state file is what a restarted Claude session is: it knows the
  // session only from disk, so this is the path where nothing but the stored record can refuse.
  const successor = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );
  await assert.rejects(
    successor.prompt({ session: "builder", text: "over here instead", cwd: elsewhere }),
    /workspace is fixed/,
    "a restarted bridge refuses it from the record alone",
  );
  const resumed = await successor.prompt({ session: "builder", text: "what did you create", cwd: workspace });
  assert.equal(resumed.sessionId, first.sessionId, "the workspace it was created in resumes the same conversation");
});

test("a killed session resumes its own conversation, from a state file a new bridge reads", async (t) => {
  // A kill takes the child and leaves the conversation: the DSH session id and its workspace are on
  // disk, so the next prompt continues the same conversation rather than starting a stranger's.
  const { bridge, pushed, workspace, stateFile, own } = stand(t);

  const first = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");
  await bridge.kill("builder");

  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
    scopes: Record<string, Record<string, { sessionId: string; cwd: string; turn: number }>>;
  };
  assert.equal(persisted.scopes[workspace].builder.sessionId, first.sessionId);
  assert.equal(persisted.scopes[workspace].builder.cwd, workspace);
  assert.equal(persisted.scopes[workspace].builder.turn, 1);

  // A different Bridge over the same state file is what a restarted Claude session is: it has
  // prompted nothing, so it reads the name off the file and resumes the conversation the file names.
  const resumedPushes: ChannelNotification[] = [];
  const successor = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: (notification) => resumedPushes.push(notification),
      log: () => undefined,
    }),
  );

  // No cwd given: the workspace is remembered, which is the half of the resume that decides where
  // the worker runs rather than which conversation it continues.
  const resumed = await successor.prompt({ session: "builder", text: "what did you create" });

  assert.equal(resumed.sessionId, first.sessionId, "the persisted DSH session id is reused, never a new one");
  assert.equal(resumed.turn, 2, "the turn count continues rather than starting over");
  await until(() => resumedPushes.length > 0, "the resumed turn to end");
  assert.equal(resumedPushes[0].params.meta.session, "builder");
});

test("a second prompt while a turn is in flight is refused rather than queued behind it", async (t) => {
  // The runtime would queue it and answer both turns with one idle, which is one answer for two
  // questions: the model would wait forever for the second. dsh_busy is the way to ask.
  const { bridge, workspace } = stand(t, ["--stop-before-idle"], SHORT_RUN);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().busy, "the turn to be in flight");

  await assert.rejects(bridge.prompt({ session: "builder", text: "and another" }), /turn in flight/);
});

test("two prompts arriving together start one worker, and the second workspace is still refused", async (t) => {
  // Claude Code issues tool calls in parallel and MCP dispatches them concurrently, so two prompts
  // in the same tick is ordinary rather than exotic. Both pass every check that reads state set by
  // the spawn, because at that moment nothing has spawned: a bridge that starts a runtime per
  // caller leaks the loser's child, which nothing closes and whose notifications reach nobody, and
  // the one-workspace rule the whole design rests on never applies to either of them.
  const { bridge, pushed, workspace } = stand(t);
  const elsewhere = path.join(workspace, "elsewhere");
  mkdirSync(elsewhere);

  const both = await Promise.allSettled([
    bridge.prompt({ session: "builder", text: "make a file", cwd: workspace }),
    bridge.prompt({ session: "other", text: "over here instead", cwd: elsewhere }),
  ]);

  assert.equal(both[0].status, "fulfilled", "the prompt that bound the workspace is accepted");
  assert.equal(both[1].status, "rejected", "the one naming a second workspace is refused, not served");
  assert.match(
    both[1].status === "rejected" ? String((both[1].reason as Error).message) : "",
    /one worker serves one workspace/,
    "and refused for that reason rather than by chance",
  );
  await until(() => pushed.length > 0, "the accepted turn to end");
  assert.equal(pushed.length, 1, "one turn ran, so one event, and no second worker streamed beside it");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] });
});

test("an idle arriving before the runtime takes the prompt ends no turn", async (t) => {
  // A resumed session reporting its loaded state, or a turn queued ahead of this one, goes idle
  // after the prompt is accepted and before the runtime says which message it is running. Ending
  // the turn there pushes an empty answer and deletes the live entry, so the real answer arrives
  // later, finds no turn, and reaches nobody: the failure this whole channel exists to prevent.
  const { bridge, pushed, workspace, replays } = stand(t, ["--idle-before-receipt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");
  await until(() => replays() >= 1, "the replay to end");

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "turn_end", "the event is the real turn's, not the premature idle's");
  assert.equal(event.meta.finish_reason, "completed");
  assert.match(event.content, /hello-from-qwen\.txt/, "and it carries the worker's answer rather than an empty body");
});

test("a state file two bridges share keeps both their sessions", async (t) => {
  // One state file per machine, and a bridge is a child of every Claude session that names the
  // plugin, so two of them hold this file at once and each knows only its own sessions. A bridge
  // that wrote its own map over the file would delete the other's names, which reads to that
  // session as a session that has forgotten itself between one prompt and the next.
  const { bridge, pushed, workspace, stateFile, own } = stand(t);
  const neighbour = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );

  await neighbour.prompt({ session: "theirs", text: "make a file", cwd: workspace });
  await bridge.prompt({ session: "mine", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "this bridge's turn to end");

  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(persisted.scopes[workspace]).sort(), ["mine", "theirs"]);
});

test("a state file that cannot be written costs the turn nothing", async (t) => {
  // The channel event is the one thing this bridge exists to deliver, and the state file is how a
  // restart resumes: writing it can fail on this platform for reasons that have nothing to do with
  // the turn, and a turn whose answer is lost to that is the failure the whole plan is about.
  const { workspace, own } = stand(t);
  const pushed: ChannelNotification[] = [];
  const logged: string[] = [];
  // A valid map, so the read under every write succeeds, and a directory where the write puts its
  // temporary sibling, so the publication fails on every write and none of the failures is this
  // test's own doing. A state file staged under a regular file would fail at a point the platform
  // chooses, a read fault on POSIX and no file at all on Windows; this shape is a publication
  // failure everywhere, which is the branch this test pins.
  const stateFile = path.join(workspace, "blocked", "sessions.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: {} }));
  mkdirSync(`${stateFile}.${String(process.pid)}.tmp`);
  const blocked = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: (notification) => pushed.push(notification),
      log: (line) => logged.push(line),
    }),
  );
  await blocked.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "turn_end", "the answer reaches the model even though nothing could be written");
  // Said by its code alone, on the same rule the reader's line already follows and for the same
  // reason: both are filesystem errors on this one file, whose path runs through a directory
  // carrying the operator's user name, and both lines land in a debug log. The two are pinned
  // together because a rule kept at one site and dropped at its neighbour is how the asymmetry
  // survives, each site reading correctly on its own.
  const unwritten = logged.find((line) => line.includes("session map could not be written"));
  assert.ok(unwritten !== undefined, `the failure is said out loud rather than swallowed: ${logged.join(" | ")}`);
  assert.match(unwritten, /\(E[A-Z]+\)/, "by its code");
  assert.ok(!unwritten.includes(workspace), `and not by the path it was raised on: ${unwritten}`);
});

test("remembered answers from this process's own copy, which a state-file write failure never reaches", async (t) => {
  // The shape a dispatch resolving "what record does this turn write to" from a separate read of the
  // state file can get wrong: a write `prompt` makes is logged and never raised on failure, so
  // `this.sessions` still carries the record it intended while the file on disk does not, and a
  // fresh `readState` of that file disagrees with what `prompt` is about to use. `remembered` is the
  // same lookup `prompt` makes, so it cannot disagree with it.
  const { workspace, own } = stand(t);
  const stateFile = path.join(workspace, "blocked", "sessions.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: {} }));
  mkdirSync(`${stateFile}.${String(process.pid)}.tmp`);
  const blocked = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );
  const recordFile = path.join(workspace, "record.md");

  await blocked.prompt({ session: "builder", text: "make a file", cwd: workspace, record: recordFile });

  assert.equal(blocked.remembered("builder")?.record, recordFile, "this process's own copy has the record, write failure notwithstanding");
  assert.equal(readState(stateFile, workspace).get("builder"), undefined, "while a fresh read of the file the write never reached has nothing at all");
});

test("remembered hands back a snapshot, not the live record a later turn's end goes on to mutate", async (t) => {
  // `remembered` can return this bridge's own live entry, the same object `finish` writes the
  // runtime's turn number into once the turn it describes ends. A caller holding that object rather
  // than a copy of it would see its own snapshot change out from under it once the turn it read
  // during finishes, which is exactly the shape a second caller of this lookup (a rotate's own busy
  // check, resolving each name's record the same way) is about to become.
  const { bridge, pushed, workspace } = stand(t);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  const before = bridge.remembered("builder");
  assert.equal(before?.turn, 0, "the count as of the last turn that finished, taken before this one has");

  await until(() => pushed.length > 0, "the turn to end");

  assert.equal(before?.turn, 0, "the earlier snapshot still reads as it did at the call, the turn's own end notwithstanding");
  assert.equal(bridge.remembered("builder")?.turn, 1, "a fresh call sees the turn the snapshot above was taken before");
});

test("a status names the session, its workspace and what its log records", async (t) => {
  const { bridge, pushed, workspace } = stand(t);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const live = bridge.status("builder");
  assert.equal(live.state, "live");
  assert.equal(live.cwd, workspace);
  assert.equal(live.inFlight, false);
  assert.ok(live.lastNotification !== undefined, "the runtime has spoken about this session");
  // The stand-in writes no session log, and a session whose log is not on disk is reported without
  // one rather than refused: the log is written by the runtime, not by the bridge.
  assert.equal(live.log, undefined);

  await bridge.kill("builder");
  assert.equal(bridge.status("builder").state, "stored", "with the child gone the session is stored");
  assert.throws(() => bridge.status("nobody"), /No session named/);
});

test("a status whose log is on disk and cannot be read still names the state and the in-flight bit", async (t) => {
  // Half of a status comes from the child and never needed the log: whether this bridge holds a
  // runtime for the session, whether a turn is in flight, the count and the last notification. The
  // log read fails on ordinary states, a container past its ceiling, a file the runtime holds
  // unshared, a generation that rotated between the directory scan and the open, and a status that
  // raised on any of those lost the model the one thing it asked for, which is whether to wait. The
  // log here is a directory where the file belongs, which is a read that fails on every platform.
  const { bridge, workspace } = stand(t, ["--stop-before-idle"], SHORT_RUN);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().busy, "the turn to be in flight");
  const id = bridge.status("builder").sessionId;
  const directory = path.join(workspace, "home", "sessions", "a-workspace-key", id);
  const file = path.join(directory, "session.jsonl.zstd");
  mkdirSync(file, { recursive: true });

  const status = bridge.status("builder");

  assert.equal(status.state, "live", "the runtime state is reported with the log unread");
  assert.equal(status.inFlight, true, "and so is the in-flight bit, which is what the model asked for");
  assert.equal(status.log, undefined, "the counts are absent rather than invented");
  assert.match(status.logUnread ?? "", /EISDIR/, `and the reason names the failure: ${String(status.logUnread)}`);
  assert.ok(!(status.logUnread ?? "").includes(workspace), "without naming the path, which runs through the harness home");
  assert.match(status.logUnread ?? "", /dsh_status/, "and names the model's next move rather than stopping at the code");
  // The tail keeps raising on the same log, because the log is that tool's whole subject and a
  // degraded tail would be an empty answer to a direct question.
  // By the code alone: the raw filesystem error names the log's path, which runs through the harness
  // home under the operator's user name, and the tail's refusal reaches the model through the tool's
  // catch-all, which neutralizes tags and not paths. The same rule the status line takes above.
  assert.throws(
    () => bridge.tail("builder"),
    (error: Error) => /EISDIR/.test(error.message) && !error.message.includes(workspace) && /dsh_status/.test(error.message),
    "dsh_tail raises where dsh_status degrades, naming the code, the next move, and never the path",
  );

  // A log past the counts-only ceiling is the same degraded report, naming the ceiling and the tool
  // that still reads the file; it is not read whole for counts, and the counts are not zero.
  rmSync(file, { recursive: true, force: true });
  writeFileSync(file, Buffer.alloc(MAX_STATUS_LOG_BYTES + 1));
  const large = bridge.status("builder");
  assert.equal(large.inFlight, true);
  assert.equal(large.log, undefined, "a log past the status ceiling yields no counts");
  assert.ok(
    (large.logUnread ?? "").includes(String(MAX_STATUS_LOG_BYTES)) && /dsh_tail/.test(large.logUnread ?? ""),
    `the reason names the ceiling and points at dsh_tail: ${String(large.logUnread)}`,
  );

  // The control: a log the reader can open reports its counts on the same call, so the two above
  // are the guard rather than a status that has stopped reading logs.
  writeFileSync(file, Buffer.alloc(0));
  const readable = bridge.status("builder");
  assert.deepEqual(readable.log?.events, 0, "an empty container reads as zero events");
  assert.equal(readable.logUnread, undefined);
});

test("a session name past the bound is refused where it enters, and the state file is byte-identical afterwards", async (t) => {
  // A name becomes a key in the session map, in the routing map, and in the state file every bridge
  // on the machine shares. That file is refused whole past its ceiling, so one prompt carrying a
  // name of a few megabytes would put it past the ceiling and every bridge in every scope would then
  // refuse the file for good, until a person deleted it by hand. The bound sits at the prompt, which
  // is where the value enters, so the map, the file and every refusal that quotes the name are
  // bounded by the one rule.
  const { bridge, pushed, workspace, stateFile } = stand(t);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the first turn to end, so the file has bytes to compare");
  const before = readFileSync(stateFile);

  const long = "n".repeat(MAX_SESSION_NAME + 1);
  await assert.rejects(
    bridge.prompt({ session: long, text: "make a file", cwd: workspace }),
    (error: Error) => error.message.includes(String(MAX_SESSION_NAME)) && /code points/.test(error.message),
    "a name one past the bound is refused, naming the bound",
  );

  assert.ok(readFileSync(stateFile).equals(before), "the state file is byte-identical: the name reached no key");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "and no turn was started for it");
  // The control: a name exactly at the bound is admitted and runs, so the refusal above is the bound
  // rather than a prompt that has stopped taking names. Counted in code points, since that is what
  // the schema's maxLength counts.
  const exact = "n".repeat(MAX_SESSION_NAME);
  const receipt = await bridge.prompt({ session: exact, text: "make a file", cwd: workspace });
  assert.equal(receipt.turn, 1);
  await until(() => pushed.length > 1, "the turn under the longest admitted name to end");
});

test("every runtime handle is closed, whatever the one before it did, and none is closed twice", async () => {
  // `HarnessClient.close()` memoizes its own task, so a shutdown that failed returns the identical
  // rejection to every later caller: a handle whose close failed can never be closed again, and a
  // loop that stopped at the first failure would drop the reference to a live process while leaving
  // the caller to retry an answer that is already settled.
  const closed: string[] = [];
  const logged: string[] = [];
  const good = {
    close: (): Promise<void> => {
      closed.push("good");
      return Promise.resolve();
    },
  };
  const bad = {
    close: (): Promise<void> => {
      closed.push("bad");
      return Promise.reject(new Error("the shutdown was refused"));
    },
  };

  await assert.rejects(closeAll([bad, good], (line) => logged.push(line)), /the shutdown was refused/);

  assert.deepEqual(closed, ["bad", "good"], "the failure did not end the round, so the second handle was closed too");
  assert.equal(logged.length, 1, "and it is named once, for the operator to end by hand");

  // A close that throws before it returns a promise is the same failure by another route, and it
  // must not end the round before the handles after it are closed, nor skip the line naming it.
  const abrupt = {
    close: (): Promise<void> => {
      closed.push("abrupt");
      throw new Error("the shutdown threw at once");
    },
  };
  closed.length = 0;
  await assert.rejects(closeAll([abrupt, good], (line) => logged.push(line)), /threw at once/);
  assert.deepEqual(closed, ["abrupt", "good"], "a synchronous throw did not end the round either");
  assert.equal(logged.length, 2, "and it is named too");

  // The control: with nothing failing there is no error and no line, so the two above belong to the
  // handle that refused rather than to closing at all.
  closed.length = 0;
  await closeAll([good, good], (line) => logged.push(line));
  assert.deepEqual(closed, ["good", "good"]);
  assert.equal(logged.length, 2, "nothing further was said");
});

test("a kill that lands while a prompt is starting the worker ends that turn too", async (t) => {
  // The kill waits for the spawn it is about to take down. The prompt waiting on that same spawn
  // runs its own continuation first, so it registers its turn inside the wait and a sweep taken
  // before the wait never saw it. Left there it is a turn no notification can end, because the
  // runtime it was sent to is gone: dsh_busy reports it forever and every later prompt for that
  // name is refused as having one in flight.
  const { bridge, pushed, workspace } = stand(t);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the first turn to end");
  await bridge.kill("builder");

  // The second prompt has to spawn a runtime again, which is the window this is about. Its own
  // rejection is taken at the call rather than after the kill, because the kill is what causes it
  // and a handler attached later is one Node has already reported as unhandled.
  const racing = bridge.prompt({ session: "builder", text: "and again", cwd: workspace }).then(
    () => "accepted",
    (error: unknown) => String(error),
  );
  const killed = await bridge.kill("builder");

  // The sentence names both endings it could have been: from here a kill and a runtime that died
  // under the request look the same, and the model's next move is the same either way.
  assert.match(await racing, /The worker was stopped or lost while it was taking this prompt/, "the caller is told, not promised an event");

  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "no turn is left in flight for a worker that is gone");
  assert.equal(killed.killed.length, 1, "the turn registered inside the wait is reported as killed");
  assert.equal(pushed.length, 2, "and it reaches the model as an event rather than as silence");
  assert.equal(pushed[1].params.meta.kind, "killed");

  // The control: with the worker gone and nothing in flight, the name prompts again and runs.
  const again = await bridge.prompt({ session: "builder", text: "once more", cwd: workspace });
  assert.equal(again.turn, 2);
  await until(() => pushed.length > 2, "the turn after the kill to end");
});

test("a push that throws inside a kill still stops the worker and clears the turn", async (t) => {
  // The kill sweeps every turn in flight and reports each one before the child goes. A throw out of
  // one push would end that sweep: the turns behind it stay in flight for the life of the process,
  // the child is never reaped because the close never runs, and the same shape in the runtime-lost
  // loop rejects a promise nobody holds, which takes the process down.
  const { bridge, workspace, logged, replays } = stand(t, ["--stop-before-idle"], RUN, {
    push: () => {
      throw new Error("the channel would not take it");
    },
  });

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => replays() >= 1, "the replay to end");
  assert.equal(bridge.busy().busy, true, "with no idle status the turn is still in flight");

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, ["builder"], "the kill answers rather than raising the delivery's failure");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "and the turn is not left in flight forever");
  assert.ok(
    logged.some((line) => line.includes("could not be delivered")),
    `the failed delivery is said out loud rather than swallowed: ${logged.join(" | ")}`,
  );
  // The control: the runtime really is gone, so the sweep reached the close beyond the push.
  assert.equal(bridge.status("builder").state, "stored");
});

test("a runtime that refused the first prompt for a new name is still one dsh_kill can stop", async (t) => {
  // The refusal arrives after the runtime has been spawned and bound to the workspace, and the
  // bridge drops the record for a name that had none before it. A kill answered from the session
  // map alone would then refuse, and the worker would be a live unsandboxed process bound to one
  // workspace, with every prompt naming another one refused and nothing able to end it short of the
  // Claude session exiting.
  const { bridge, workspace } = stand(t, ["--refuse-prompt"]);
  const elsewhere = path.join(workspace, "elsewhere");
  mkdirSync(elsewhere);

  // The control, taken before anything is running: the same call on the same unknown name, which
  // refuses while there is no worker. What separates it from the kill below is a live runtime, so
  // the kill below is answering one rather than answering anything at all.
  await assert.rejects(bridge.kill("builder"), /No session named/, "with no worker and no such session, a kill refuses");

  await assert.rejects(
    bridge.prompt({ session: "builder", text: "make a file", cwd: workspace }),
    (error: Error) => /refused this prompt/.test(error.message),
    "the runtime answers this prompt with an error, after the spawn that bound the workspace",
  );

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, [], "no turn was in flight, and the worker is stopped all the same");
  // And the binding went with it: a second workspace now reaches a fresh runtime, which refuses it
  // for its own reason. A bridge still holding the first worker would refuse this one before any
  // runtime saw it, saying that one worker serves one workspace.
  await assert.rejects(
    bridge.prompt({ session: "another", text: "over here instead", cwd: elsewhere }),
    (error: Error) => /refused this prompt/.test(error.message),
    "the workspace the refused prompt bound is no longer the only one this bridge will take",
  );
});

test("a turn carries its own activity and not what the session was doing when the prompt arrived", async (t) => {
  // The turn is marked in flight before the prompt is sent, so from that moment every notification
  // for the session lands on it, and until the runtime confirms which queued message it is running
  // those belong to whatever came before: a resumed session replaying its state, or a turn queued
  // ahead of this one. Kept, they answer this turn with somebody else's text and count their files
  // and commands as this worker's.
  const { bridge, pushed, workspace, replays } = stand(t, ["--before-receipt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");
  await until(() => replays() >= 1, "the replay to end");

  const event = onlyEvent(pushed);
  assert.ok(!event.content.includes("someone else's turn"), `the answer is this turn's own: ${event.content}`);
  assert.match(event.content, /hello-from-qwen\.txt/);
  assert.equal(event.meta.files_touched, "hello-from-qwen.txt", "the earlier turn's file is not this turn's work");
  assert.equal(event.meta.commands_run, "0", "nor is the command it ran");
  assert.equal(event.meta.turn, "1", "and the turn number is this turn's, not the one before it");
});

test("the workspace guard admits one place on this machine and refuses the shapes that are not one", () => {
  // Read as a table of which rule refuses which string: the remote prefixes in both spellings and
  // the device prefix that begins the same way, a path that is not rooted at all, one rooted at no
  // drive on this platform, a control character inside an otherwise ordinary path, and a length no
  // real workspace reaches. Nothing here touches the filesystem, which is the point: the guard runs
  // before the first call that would.
  const local = process.platform === "win32" ? "C:\\projects\\worker" : "/projects/worker";
  assert.equal(workspacePath(` ${local} `), local, "an absolute local path is trimmed and admitted");

  assert.equal(workspacePath("\\\\attacker\\share\\x"), undefined, "a UNC path names a host, not this machine");
  assert.equal(workspacePath("//attacker/share/x"), undefined, "and so does its forward-slash spelling");
  assert.equal(workspacePath("\\\\?\\C:\\x"), undefined, "a device path begins the same way");
  assert.equal(workspacePath("projects/worker"), undefined, "a relative path resolves against wherever this process started");
  assert.equal(workspacePath(""), undefined, "and an empty one names nothing at all");
  assert.equal(workspacePath(`${local}${String.fromCodePoint(10)}rest`), undefined, "a control character is refused, not stripped");
  // The class is protocol.ts's hidden class rather than a control range of the guard's own, so the
  // points a C0 range never named are refused by the same rule: written by code point, because an
  // invisible character in source is invisible to review.
  assert.equal(workspacePath(`${local}${String.fromCodePoint(0x200b)}rest`), undefined, "a zero-width space is refused by the hidden class");
  assert.equal(workspacePath(`${local}${String.fromCodePoint(0x0085)}rest`), undefined, "and so is a C1 control");
  assert.equal(workspacePath(`${local}${String.fromCodePoint(0x202e)}rest`), undefined, "and a bidirectional override");
  assert.equal(workspacePath(`${local}${"x".repeat(MAX_PATH_LENGTH)}`), undefined, "past the length bound");
  if (process.platform === "win32") {
    assert.equal(workspacePath("\\projects\\worker"), undefined, "a Windows path with no drive names a different place per process");
  }
});

test("the record-file guard admits workspacePath's own shapes and additionally refuses an existing directory", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-recordpath-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asDirectory = path.join(dir, "already-a-directory");
  mkdirSync(asDirectory);

  assert.equal(recordFilePath("relative/record.md"), undefined, "a relative path is refused, as workspacePath refuses it");
  assert.equal(recordFilePath(""), undefined, "and an empty one names nothing at all");
  assert.equal(recordFilePath(asDirectory), undefined, "a path naming an existing directory is not a file this bridge opens");

  // The control: an absolute path naming a file, existing or not, is admitted, so the refusals above
  // are this guard's rules rather than a function that refuses everything.
  const file = path.join(dir, "record.md");
  assert.equal(recordFilePath(file), file, "a file that does not exist yet is admitted");
  writeFileSync(file, "hi", "utf8");
  assert.equal(recordFilePath(file), file, "and so is one that already does");
});

test("insideStateDirectory admits only the state file's own directory, itself or a path inside it, folding case exactly as canonicalPath does", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-statedir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "state", "sessions.json");
  const stateDir = path.join(dir, "state");

  assert.equal(insideStateDirectory(stateFile, stateDir), true, "the directory itself");
  assert.equal(insideStateDirectory(stateFile, stateFile), true, "the map file itself");
  assert.equal(insideStateDirectory(stateFile, path.join(stateDir, "sibling.md")), true, "a sibling file in the same directory");
  assert.equal(insideStateDirectory(stateFile, path.join(stateDir, "nested", "deeper.md")), true, "a path nested under it");
  if (process.platform === "win32") {
    assert.equal(insideStateDirectory(stateFile, stateFile.toUpperCase()), true, "a case variant of the map file, folded as canonicalPath folds it");
  }

  // The control: a sibling directory whose name merely starts with the state directory's own name as
  // a string is not inside it, so this keys on the path boundary rather than on a string prefix.
  assert.equal(insideStateDirectory(stateFile, `${stateDir}-decoy`), false, "a directory name that shares a string prefix is not inside it");
  assert.equal(insideStateDirectory(stateFile, path.join(dir, "elsewhere.md")), false, "a file in the parent directory, outside the state directory");
  assert.equal(insideStateDirectory(stateFile, path.join(os.tmpdir(), "unrelated.md")), false, "an unrelated path elsewhere on the machine");
});

test("a workspace that names a host rather than a place on this machine is refused before it is opened", async (t) => {
  // `path.isAbsolute` is true of a UNC path, and the first filesystem call on one opens an outbound SMB
  // connection to a host the caller named, under the operator's credentials, before any refusal
  // could run. The same string then becomes an unsandboxed child's working directory.
  const { bridge, workspace } = stand(t);

  // The blank is refused as a path rather than read as an absent one: trimmed to nothing it would
  // fall through to the remembered workspace, and a caller that wrote a cwd would be answered by the
  // place the worker was already running.
  for (const refused of ["\\\\attacker\\share\\x", "//attacker/share/x", "\\\\?\\C:\\x", "relative/path", "  "]) {
    await assert.rejects(
      bridge.prompt({ session: "builder", text: "make a file", cwd: refused }),
      /does not name a directory on this machine/,
      `${JSON.stringify(refused)} must be refused as a path`,
    );
  }
  // The control: an absolute local path on the same call is accepted, so the refusals above are the
  // guard rather than a prompt that has stopped taking a cwd at all.
  const receipt = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  assert.match(receipt.sessionId, /^session-/);
});

test("a stored workspace no better than a caller's is dropped when the state file is read", async (t) => {
  // The state file is the bridge's own memory and is still a file anything running as this user can
  // rewrite. A prompt that omits its cwd uses the stored one whole, so a record carrying a network
  // path would reach statSync and the spawn without ever passing the check the tool argument takes.
  const { workspace, stateFile } = stand(t);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      scopes: {
        [workspace]: {
          remote: { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: "\\\\attacker\\share\\x", turn: 1 },
          local: { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: workspace, turn: 1 },
        },
      },
    }),
  );

  const sessions = readState(stateFile, workspace, () => undefined);

  assert.deepEqual([...sessions.keys()], ["local"], "the record naming a host is not remembered");
  assert.equal(sessions.get("local")?.cwd, workspace, "and the one naming this machine is");
});

test("a kill inside the prompt request writes no session id the runtime never took", async (t) => {
  // The state file is what a resume reads. A turn killed before the runtime answered its request is
  // one whose runtime is gone, so no live runtime is running its id, and the runtime that is gone may
  // never have opened a session for it; the kill's revert takes the record back rather than writing
  // a name down against an id nothing is known to have opened.
  const { bridge, pushed, ended, workspace, stateFile } = stand(t, ["--swallow-prompt"]);

  const inflight = bridge.prompt({ session: "solo", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().busy, "the turn to be in flight");
  const killed = await bridge.kill("solo");
  await assert.rejects(inflight, "the prompt whose runtime went away is not answered with a receipt");

  assert.deepEqual(killed.killed, ["solo"]);
  assert.equal(pushed.length, 1, "the killed turn is still reported");
  assert.equal(pushed[0].params.meta.kind, "killed");
  // The claim published for the name while its request was out is taken back with the request's
  // failure, so the file holds no record for it: the scope exists, since the claim was written, and
  // the name is not in it.
  assert.deepEqual(Object.keys(scopeOnDisk(stateFile, workspace)), [], "and no record for it is left on disk");
  // The listener is told the runtime never answered for this turn, which is what lets a record
  // writer withhold a worker section for a prompt it never recorded.
  assert.equal(ended.length, 1);
  assert.equal(ended[0].accepted, false, "the turn-end payload says the prompt was never accepted");
  assert.equal(ended[0].kind, "killed");
});

/** This scope's records as the state file holds them now, empty when the file or the scope is absent. */
function scopeOnDisk(stateFile: string, scope: string): Record<string, { sessionId: string; cwd: string; turn: number; record?: string }> {
  if (!existsSync(stateFile)) return {};
  const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
    scopes: Record<string, Record<string, { sessionId: string; cwd: string; turn: number; record?: string }>>;
  };
  return parsed.scopes[scope] ?? {};
}

/**
 * Put a session log where the runtime would, for the id a turn in flight carries.
 *
 * The bridge names the id in its status from the moment the record is set, which is before the
 * runtime has answered, so a test can learn it there and write the log the runtime would have. An
 * empty container is a log the reader finds and reads as no frames at all.
 */
function seedLog(bridge: Bridge, workspace: string, session: string): string {
  const id = bridge.status(session).sessionId;
  const directory = path.join(workspace, "home", "sessions", "a-workspace-key", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "session.jsonl.zstd"), Buffer.alloc(0));
  return id;
}

test("a prompt whose request times out ends its turn as unattributed rather than leaving it in flight", async (t) => {
  // The runtime may be running a prompt it did not answer for, and the bridge never learns the
  // queued message id, so nothing the session does from here can be attributed to this turn. Left in
  // flight, the turn would wait on an idle it could never attribute, and if that idle had already
  // arrived inside the bound it was the turn's only end: the turn would sit until dsh_kill while the
  // model was told to wait for an event that was never coming. So the turn ends at the timeout, as
  // an error the model can read, and the name is free to prompt again.
  //
  // The bound is on the prompt alone. The request bound covers the `initialize` handshake too, and
  // that handshake is a process spawn and a boot, so a bound tight enough to fail the swallowed
  // prompt quickly is one a contended machine fails the handshake on, from outside the `try` that
  // rewords it; the handshake keeps the suite's patience and only the prompt is held to 500 ms.
  const { bridge, pushed, ended, workspace, stateFile } = stand(t, ["--swallow-prompt"], RUN, { promptTimeoutMs: 500 });

  // A log is on disk before the bound elapses, so the refusal's pointer at `dsh_tail` has something
  // to read; the record is kept with or without it.
  const inflight = bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().sessions.includes("builder"), "the turn to be in flight");
  seedLog(bridge, workspace, "builder");
  await assert.rejects(
    inflight,
    (error: Error) =>
      /finish_reason unattributed/.test(error.message) &&
      /nothing is in flight/.test(error.message) &&
      !/wait for its channel event/.test(error.message) &&
      error.message.includes("turn 1") &&
      error.message.includes("builder"),
    "the refusal names the turn that was ended and does not tell the model to wait",
  );

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "error", "the turn ended as an error rather than as an answer");
  assert.equal(event.meta.finish_reason, "unattributed", "with the bridge's own word for why");
  assert.equal(event.meta.turn, "1");
  assert.equal(event.content, "", "and nothing observed rides in it, since none of it is known to be this turn's");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "no turn is left in flight for an answer that cannot arrive");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].accepted, false, "the listener is told the runtime never answered for the turn");
  assert.equal(ended[0].finishReason, "unattributed");

  // The runtime may be running the prompt, so the turn is counted and the record is written: the
  // next prompt resumes the conversation rather than minting a second one beside it.
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, { turn: number }>> };
  assert.equal(persisted.scopes[workspace].builder.turn, 1, "the unattributed turn is counted");

  // The control: the name prompts again rather than being refused as in flight. The stand-in swallows
  // this one too, so it ends the same way, one bound later, as turn two.
  await assert.rejects(
    bridge.prompt({ session: "builder", text: "and again" }),
    (error: Error) => !/turn in flight/.test(error.message) && error.message.includes("turn 2"),
    "the second prompt reached the runtime rather than being refused as a turn in flight",
  );
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].params.meta.turn, "2");
});

test("a first-turn timeout keeps the session id and counts the turn, with no log on disk for it", async (t) => {
  // The id of a first turn was minted here by the SDK a moment before the request went out, and
  // whether the runtime opened a session for it inside the bound cannot be known from here: it may be
  // running the prompt under that id now. Forgetting the id would have the next prompt for the name
  // mint a second one, and two unsandboxed workers would then write one workspace at once. Keeping
  // it costs at most one name its
  // conversation, if the runtime refuses an id it never opened; what the runtime does with such an
  // id is unmeasured, the SDK documenting that an unknown id creates the session, and Section 5's
  // live run is where it is observed. So the record is kept whether or not a log exists for it.
  const { bridge, pushed, workspace, stateFile } = stand(t, ["--swallow-prompt"], RUN, { promptTimeoutMs: 500 });

  await assert.rejects(
    bridge.prompt({ session: "fresh", text: "make a file", cwd: workspace }),
    (error: Error) =>
      /finish_reason unattributed/.test(error.message) &&
      /nothing is in flight/.test(error.message) &&
      /dsh_tail/.test(error.message) &&
      !/not remembered/.test(error.message),
    "the refusal sends the model to the log and does not say the name is forgotten",
  );
  assert.equal(onlyEvent(pushed).meta.kind, "error", "the turn is ended and reported");
  const id = bridge.status("fresh").sessionId;
  assert.match(id, /^session-[0-9a-f]{32}$/, "the name is remembered under the id the SDK minted");
  assert.equal(bridge.status("fresh").log, undefined, "with no log on disk for it");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, { sessionId: string; turn: number }>> };
  assert.equal(persisted.scopes[workspace].fresh.sessionId, id, "and the id reached the file");
  assert.equal(persisted.scopes[workspace].fresh.turn, 1, "with the turn counted");

  // The next prompt resumes the same id rather than minting a second one: no cwd is asked for, and
  // the count continues. The stand-in swallows this one too, so it ends the same way as turn two.
  await assert.rejects(
    bridge.prompt({ session: "fresh", text: "again" }),
    (error: Error) => !/needs its cwd/.test(error.message) && error.message.includes("turn 2"),
    "the name is remembered, so its next prompt is turn two of the same session",
  );
  assert.equal(bridge.status("fresh").sessionId, id, "under the same id");
});

test("a push that throws does not revert a turn that was delivered", async (t) => {
  // The whole turn can arrive before the response to the prompt that started it, and the bridge
  // then ends that turn from inside its own prompt call. Treating a throwing push as a failed
  // prompt would forget a session the runtime has, and the next prompt would mint a second DSH
  // conversation for a name that already had one.
  const { bridge, workspace } = stand(t, ["--end-before-response"], RUN, {
    push: () => {
      throw new Error("the channel would not take it");
    },
  });

  // Taken either way: what the caller is told about a delivery it did not make is not the property
  // here, and a bridge that reverts the turn hands back the same error a bridge that keeps it does.
  const outcome = await bridge
    .prompt({ session: "builder", text: "make a file", cwd: workspace })
    .then(() => "a receipt", (error: unknown) => String(error));

  const status = bridge.status("builder");
  assert.match(status.sessionId, /^session-[0-9a-f]{32}$/, `the session the runtime accepted is still remembered (${outcome})`);
  assert.equal(status.inFlight, false, "and its turn ended rather than being left in flight");
  assert.equal(bridge.busy().busy, false);
});

test("the turn-end listener runs before prompt returns when the turn ends inside the request, and says the runtime accepted it", async (t) => {
  // A record writer appends the prompting party's section once the runtime has accepted the prompt
  // and the worker's section at turn end, in that order. The runtime can finish the whole turn before
  // it answers the prompt request, and the bridge then ends the turn from inside its own prompt call,
  // so the listener runs before the caller holds a receipt. What the writer can rely on is pinned
  // here: the listener has already run when `prompt` returns, its payload says the runtime accepted
  // the prompt, and the receipt names the same turn.
  const { bridge, pushed, ended, workspace } = stand(t, ["--end-before-response"], RUN);

  const receipt = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });

  assert.equal(ended.length, 1, "the listener ran before the prompt call returned");
  assert.equal(ended[0].accepted, true, "and was told the runtime accepted the prompt");
  assert.equal(ended[0].kind, "turn_end");
  assert.equal(ended[0].turn, receipt.turn, "and names the turn the receipt names");
  assert.equal(pushed.length, 1, "with the channel event pushed alongside it");
});

test("a turn that finishes before its own receipt is confirmed still carries the worker's answer", async (t) => {
  // The runtime can splice the message into the inbox, run the whole turn, and go idle before the
  // prompt request returns the id to compare that receipt against. Everything gathered after the
  // receipt is this turn's own, so a bridge that discards it at confirmation time pushes an empty
  // `turn_end` and the worker's answer reaches nobody, which is the failure this section exists to
  // prevent: the event is the only route the response has.
  const { bridge, pushed, workspace } = stand(t, ["--end-before-response"], RUN);

  await bridge
    .prompt({ session: "builder", text: "make a file", cwd: workspace })
    .then(() => undefined, () => undefined);

  assert.equal(pushed.length, 1, "exactly one event for the finished turn");
  const event = pushed[0].params;
  assert.equal(event.meta.kind, "turn_end");
  assert.match(event.content, /hello-from-qwen/, `the worker's own words reached the event: ${JSON.stringify(event.content)}`);
  assert.match(
    event.meta.files_touched,
    /hello-from-qwen\.txt/,
    `and so did what it touched: ${JSON.stringify(event.meta.files_touched)}`,
  );
});

test("a session whose request is still out is on disk with its count withheld, and is taken back when the request fails", async (t) => {
  // The record is set before the prompt goes out, because the notifications it produces arrive
  // while the call is still waiting on its own answer, and it reaches the file at the same moment,
  // so a bridge that dies inside the request leaves the id it may be running the prompt under. What
  // the record does not carry is a count for the turn in flight: the runtime is not known to have
  // taken it. And what a failed request leaves on disk is taken back, so a restarted bridge does not
  // remember a record that a refusal or a kill was meant to give up.
  const { bridge, pushed, workspace, stateFile } = stand(t, ["--swallow-first-prompt"]);

  const unanswered = bridge.prompt({ session: "unanswered", text: "make a file", cwd: workspace }).then(
    () => "accepted",
    (error: unknown) => String(error),
  );
  await until(() => bridge.busy().sessions.includes("unanswered"), "the first turn to be in flight");
  await bridge.prompt({ session: "answered", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the second session's turn to end");

  const during = scopeOnDisk(stateFile, workspace);
  assert.deepEqual(Object.keys(during).sort(), ["answered", "unanswered"], "both names are on disk while the first's request is out");
  assert.match(during.unanswered.sessionId, /^session-[0-9a-f]{32}$/, "the record carries the session id the prompt is out under");
  assert.equal(during.unanswered.turn, 0, "and no count for the turn in flight");
  assert.equal(during.answered.turn, 1, "while the finished turn is counted");

  const killed = await bridge.kill("unanswered");
  assert.deepEqual(killed.killed, ["unanswered"], "the turn whose request was out is the one the kill ends");
  assert.match(await unanswered, /stopped or lost/, "and its prompt fails on the closed transport");
  const after = scopeOnDisk(stateFile, workspace);
  // The control rides in the same reading: the neighbour's own record is still there, so the
  // absence beside it is the claim being taken back rather than a write that emptied the scope.
  assert.deepEqual(Object.keys(after), ["answered"], "the claim for the name the runtime never took is gone from disk");
  assert.equal(after.answered.turn, 1, "and the finished session's record is untouched");
});

test("a record the state file's reader refuses is named once per process, however often the file is read", async (t) => {
  // The reader runs at construction, twice per prompt, and at every status and tail, and a record it
  // refuses is carried through every write exactly as it was, so the record never leaves the file:
  // named on every read, one malformed neighbour would put the same line in the debug log on every
  // tool call for the life of the process.
  const { workspace, stateFile, own } = stand(t);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      scopes: {
        [workspace]: {
          broken: { sessionId: "not-a-session-id", cwd: workspace, turn: 1 },
          builder: { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: workspace, turn: 2 },
        },
      },
    }),
  );
  const logged: string[] = [];
  const bridge = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: (line) => logged.push(line),
    }),
  );

  // Three reads past the constructor's, each of which the reader refuses the neighbour on.
  bridge.status("builder");
  bridge.status("builder");
  assert.throws(() => bridge.tail("builder"), /no log on disk/);

  const refusals = logged.filter((line) => line.includes("'broken' names no DSH session id"));
  assert.equal(refusals.length, 1, `the neighbour is named once: ${logged.join(" | ")}`);
  // The control: the line was said at all, so the count above is a sink that says each line once
  // rather than a reader that has stopped reporting what it refuses.
  assert.ok(refusals.length > 0);
});

test("a prompt's record is taken back from the file only where the file still carries the session id it wrote", (t) => {
  // The write side of a prompt's revert, in its three dispositions. A name whose entry still carries
  // the id the prompt wrote goes back to what it was, or to nothing where there was nothing; a name
  // whose entry names another conversation is left as it is, since that record is not this prompt's
  // to change; and a file with no entry for the name is not rewritten at all, since a record that
  // never reached disk leaves nothing to take back.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "sessions.json");
  const id = (digit: string): string => `session-${digit.repeat(32)}`;
  const before: SessionRecord = { sessionId: id("a"), cwd: dir, turn: 3 };
  const fresh: SessionRecord = { sessionId: id("b"), cwd: dir, turn: 0 };
  const other: SessionRecord = { sessionId: id("c"), cwd: dir, turn: 5 };
  const mine: SessionRecord = { sessionId: id("d"), cwd: dir, turn: 0 };
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      scopes: {
        [dir]: {
          resumed: { ...before, turn: 9 },
          fresh,
          moved: other,
        },
      },
    }),
  );

  releaseState(stateFile, dir, "resumed", before, before);
  releaseState(stateFile, dir, "fresh", fresh, undefined);
  releaseState(stateFile, dir, "moved", mine, before);

  const after = scopeOnDisk(stateFile, dir);
  assert.deepEqual(after.resumed, before, "a name whose entry carries the id the prompt wrote goes back to the record it had");
  assert.equal(Object.hasOwn(after, "fresh"), false, "a name that had no record before the prompt has none after it");
  assert.deepEqual(after.moved, other, "a name whose entry names another conversation is left as it is");

  // The control for the unchanged case: a release with nothing to take back leaves the file's bytes
  // as they were, which is what says the two above were rewrites rather than every call rewriting.
  const bytes = readFileSync(stateFile);
  releaseState(stateFile, dir, "moved", mine, before);
  releaseState(stateFile, dir, "absent", fresh, undefined);
  assert.ok(readFileSync(stateFile).equals(bytes), "a file with no entry carrying the id is not rewritten");
});

test("what a turn remembers of the files it wrote is bounded, whatever the worker writes", () => {
  // The end-to-end test below reads what the receipt renders, and the receipt renders twenty and a
  // remainder whether the turn held twenty-one paths or a hundred thousand. This is the reading of
  // the bound itself: a worker looping over a large tree is the ordinary case, and every path it
  // names is worker-chosen text held for the length of the turn.
  const touched: TouchedFiles = { named: new Set(), extra: 0 };

  for (let index = 0; index < 10_000; index += 1) noteFile(touched, `file-${String(index)}.ts`);

  assert.equal(touched.named.size, MAX_RETAINED_FILES, "the list stops at what the receipt can name and one more");
  assert.equal(touched.extra, 10_000 - MAX_RETAINED_FILES, "and everything past it is still counted");
  assert.deepEqual([...touched.named].slice(0, 2), ["file-0.ts", "file-1.ts"], "the paths kept are the first ones");

  // A path already retained is not a second path, however often the worker writes it.
  noteFile(touched, "file-0.ts");
  assert.equal(touched.extra, 10_000 - MAX_RETAINED_FILES, "a rewrite of a retained path counts nothing");

  // The control: a turn that stays inside the bound retains everything and counts nothing, so the
  // numbers above are the bound rather than a counter that has started dropping paths at once.
  const few: TouchedFiles = { named: new Set(), extra: 0 };
  noteFile(few, "a.ts");
  noteFile(few, "b.ts");
  noteFile(few, "a.ts");
  assert.deepEqual([...few.named], ["a.ts", "b.ts"]);
  assert.equal(few.extra, 0);
});

test("a turn that touches more files than the receipt names keeps a bounded list and counts the rest", async (t) => {
  // A worker looping over a tree is the ordinary case rather than an attack, and every distinct
  // path it names is worker-chosen text. Held whole for the turn's life it is unbounded memory, and
  // deduplicated by a scan of the list it is quadratic in the size of the loop; the receipt renders
  // twenty and a remainder either way.
  const { bridge, pushed, workspace } = stand(t, ["--files", "60"]);

  await bridge.prompt({ session: "builder", text: "write the tree", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const value = onlyEvent(pushed).meta.files_touched;
  const named = value.split(",");
  assert.equal(named.length, MAX_META_FILES + 1, `twenty paths and a remainder: ${value}`);
  assert.equal(named[0], "looped-0.txt", "the first paths the turn touched are the ones it names");
  // Sixty looped writes and the capture's own one, less the twenty named.
  assert.equal(named[MAX_META_FILES], "+41", `the remainder counts every path beyond the list: ${value}`);
});

test("a finished turn reaches the turn-end listener whole while its channel event carries the answer cut", async (t) => {
  // Two readers of one answer. The channel event is read by a model inside its own context window,
  // so its body is cut at the content cap; the turn-end listener feeds the record a person reads,
  // where the whole answer belongs. Both halves are asserted on one turn of one bridge rather than
  // in two tests against two literals, because a writer and a reader each tested against their own
  // literal is how a listener quietly handed the cut copy stays green on both sides.
  const chars = MAX_CHANNEL_CONTENT + 500;
  const { bridge, pushed, ended, workspace } = stand(t, ["--answer-chars", String(chars)]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0 && ended.length > 0, "the turn to end on both readers");

  const event = onlyEvent(pushed);
  assert.equal(ended.length, 1, "one turn, one turn-end");
  const [turnEnd] = ended;
  const whole = "a".repeat(chars);
  // The listener's half: the length first, so a cut copy fails on a number rather than on a diff of
  // twelve thousand characters, and then the text itself.
  assert.equal([...turnEnd.text].length, chars, "the listener receives every code point the worker produced");
  assert.equal(turnEnd.text, whole, "and exactly the text it produced");
  assert.equal(turnEnd.session, "builder");
  assert.equal(turnEnd.kind, "turn_end");
  assert.equal(turnEnd.accepted, true, "the runtime answered the prompt, and the listener is told so");
  assert.equal(String(turnEnd.turn), event.meta.turn, "the listener and the event describe the same turn");
  assert.equal(turnEnd.finishReason, event.meta.finish_reason);
  // The event's half, on the same turn: cut at the cap, and a prefix of what the listener got.
  assert.equal([...event.content].length, MAX_CHANNEL_CONTENT, "the channel body is cut at the cap");
  assert.ok(turnEnd.text.startsWith(event.content), "and is the head of the whole answer, not a different text");
});

test("a write keeps another bridge's records, in another scope and in this one, including one this version would not admit", async (t) => {
  // The file is one path per machine and a bridge uses only the records it can read. A record
  // another bridge wrote in a shape this one refuses is still that bridge's memory of a live
  // conversation: dropped on this write it is a session that has forgotten itself, with nothing said
  // to anyone. Two Claude sessions in one project are two bridges in one scope, so the same-scope
  // neighbour is as real as the other-scope one, and both are asserted on one write.
  const { bridge, pushed, workspace, stateFile, logged } = stand(t);
  const stranger = { theirs: { sessionId: "not-a-session-id", cwd: "\\\\host\\share", turn: 4 } };
  const neighbour = { sessionId: "not-a-session-id-either", cwd: "\\\\host\\share", turn: 7, owner: { pid: "text" } };
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ version: 2, scopes: { "a-stranger-scope": stranger, [workspace]: { neighbour } } })}\n`, "utf8");

  await bridge.prompt({ session: "mine", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "this bridge's turn to end");

  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, unknown>> };
  assert.deepEqual(persisted.scopes["a-stranger-scope"], stranger, "the other scope is carried through as it was written");
  assert.deepEqual(persisted.scopes[workspace].neighbour, neighbour, "and so is the same-scope neighbour this bridge cannot read");
  // The control: this bridge's own record landed in the same file, so the survival above is the
  // carry-through rather than a write that never happened; and the neighbour was refused where it
  // was read, so what survived is a record this bridge did not use.
  assert.ok(Object.keys(persisted.scopes[workspace]).includes("mine"), "and this scope's own write landed beside it");
  assert.ok(logged.some((line) => line.includes("'neighbour' names no DSH session id")), `the neighbour is refused at the read: ${logged.join(" | ")}`);
  assert.throws(() => bridge.status("neighbour"), /No session named/, "and is not a session this bridge answers for");
});

test("a prompt the kill outran leaves no record for a name that had none", async (t) => {
  // The runtime answers the prompt as it shuts down, which is the ordering where the request
  // succeeds and the turn it was for has already been reported as killed. The record was written
  // before the prompt went out, so a name that had none before would be left holding a session id no
  // live runtime is running, and which the runtime that is gone may never have opened.
  const { bridge, workspace, stateFile } = stand(t, ["--answer-at-shutdown"]);

  const racing = bridge.prompt({ session: "fresh", text: "make a file", cwd: workspace }).then(
    () => "accepted",
    (error: unknown) => String(error),
  );
  await until(() => bridge.busy().sessions.includes("fresh"), "the turn to be in flight");
  const killed = await bridge.kill("fresh");

  assert.deepEqual(killed.killed, ["fresh"], "the turn in flight is reported rather than dropped");
  assert.match(await racing, /stopped or lost/, "and the caller is told rather than promised an event");
  assert.throws(() => bridge.status("fresh"), /No session named/, "the name that had no record before has none now");
  assert.equal(Object.hasOwn(scopeOnDisk(stateFile, workspace), "fresh"), false, "nor is the claim published for it still on disk");
});

test("two projects naming one worker keep their own sessions in one state file", async (t) => {
  // The state file is one path per machine and `builder` is the name both of them chose. Keyed by
  // name alone the second bridge's record replaces the first's, and the first, restarted, resumes a
  // stranger's conversation in a stranger's workspace.
  const { bridge, pushed, workspace, stateFile, own } = stand(t);
  const elsewhere = path.join(workspace, "another-project");
  mkdirSync(elsewhere);
  const theirs = own(
    new Bridge({
      stateFile,
      scope: elsewhere,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );

  const mine = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "this bridge's turn to end");
  const stranger = await theirs.prompt({ session: "builder", text: "make a file", cwd: elsewhere });
  // Closed here as part of the test's own flow, so the file below is read with the stranger's
  // runtime gone; the hook closes it again, which is idempotent.
  await theirs.close();

  assert.notEqual(mine.sessionId, stranger.sessionId, "two projects, two conversations, one name");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
    scopes: Record<string, Record<string, { sessionId: string; cwd: string }>>;
  };
  assert.deepEqual(Object.keys(persisted.scopes).sort(), [workspace, elsewhere].sort());
  assert.equal(persisted.scopes[workspace].builder.sessionId, mine.sessionId);
  assert.equal(persisted.scopes[elsewhere].builder.sessionId, stranger.sessionId);

  // A restart of this project's bridge is what would adopt the stranger's record, and this is the
  // reading that says it does not: the id and the workspace are the ones this scope created.
  const successor = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );
  const resumed = successor.status("builder");
  assert.equal(resumed.sessionId, mine.sessionId, "the restarted bridge resumes its own conversation");
  assert.equal(resumed.cwd, workspace, "in its own workspace");
});

test("a prompt whose read of the session map failed is refused before any runtime is spawned, naming the fault and never the path or the bytes", async (t) => {
  // The write is two acts. Its read can fail: the file is present and does not read under this
  // version's rules, and then nothing was compared and nothing was published, for as long as the file
  // stays so. That failure refuses the prompt, where a publication that failed after a clean read
  // proceeds, and it refuses before the runtime is started: refused only at the write, every attempt
  // would spend a spawn and leave a live child bound to the workspace that is never prompted, so the
  // observation here is the stand-in's own spawn marker rather than `busy()`, which is empty after a
  // refusal either way. The refusal names which fault it was and the remedy that fits it, and carries
  // neither the file's path, which runs through the operator's user name, nor the file's bytes, which
  // are every session name and workspace path the machine remembers.
  const { workspace, own } = stand(t);
  const stateFile = path.join(workspace, "state", "sessions.json");
  const spawnFile = path.join(workspace, "spawned.log");
  const secret = "the-file-bytes-nobody-should-read";
  // The advice differs by fault. A file that is past the ceiling, not JSON or not a session map stays
  // so until somebody changes it, so the model is sent to the operator; a filesystem refusal can be a
  // neighbour or a scanner holding the file for a moment, which clears in milliseconds, so the model
  // is told to prompt again first and sent to the operator only if it persists. The read still did not
  // happen in that case, so the refusal itself is the same; only what to do about it differs.
  const faults: { name: string; stage: () => void; said: RegExp; advice: RegExp }[] = [
    { name: "not JSON", stage: () => writeFileSync(stateFile, `{ not json ${secret}`), said: /does not parse/, advice: /does not clear by itself/ },
    { name: "not a session map", stage: () => writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: [], marker: secret })), said: /not a session map/, advice: /does not clear by itself/ },
    { name: "oversized", stage: () => writeFileSync(stateFile, Buffer.alloc(MAX_STATE_BYTES + 1, "x")), said: new RegExp(String(MAX_STATE_BYTES)), advice: /does not clear by itself/ },
    // The filesystem member is a directory at the file's path, which this platform reads as `EISDIR`.
    // A file staged under a regular file is not a member here: on Windows the stat of such a path is
    // `ENOENT`, which is absent rather than a read failure, and `ENOTDIR` is not raised for it.
    { name: "a directory", stage: () => mkdirSync(stateFile, { recursive: true }), said: /cannot be read \(EISDIR\)/, advice: /prompt again first/ },
  ];
  for (const fault of faults) {
    rmSync(stateFile, { recursive: true, force: true });
    rmSync(spawnFile, { force: true });
    mkdirSync(path.dirname(stateFile), { recursive: true });
    fault.stage();
    const before = statSync(stateFile).isDirectory() ? undefined : readFileSync(stateFile);
    const logged: string[] = [];
    const bridge = own(
      new Bridge({
        stateFile,
        scope: workspace,
        home: path.join(workspace, "home"),
        runtime: { command: process.execPath, args: [FAKE, RUN, "--spawn-file", spawnFile], env: process.env, requestTimeoutMs: PATIENCE_MS },
        provider: "fake-provider",
        model: "fake-model",
        push: () => undefined,
        log: (line) => logged.push(line),
      }),
    );

    let refusal = "";
    await assert.rejects(
      bridge.prompt({ session: "builder", text: "make a file", cwd: workspace }),
      (error: Error) => {
        refusal = error.message;
        return fault.said.test(refusal) && /was not prompted/.test(refusal) && /repair or remove/.test(refusal);
      },
      `a map that is ${fault.name} refuses the prompt, naming the fault and the remedy: ${refusal}`,
    );
    assert.match(refusal, fault.advice, `the advice fits the fault (${fault.name})`);
    assert.equal(/prompt again first/.test(refusal), fault.name === "a directory", `and only a filesystem refusal is told to prompt again first (${fault.name}): ${refusal}`);
    assert.ok(!refusal.includes(workspace), `the refusal names no path (${fault.name}): ${refusal}`);
    assert.ok(!refusal.includes(secret), `and none of the file's bytes (${fault.name}): ${refusal}`);
    assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, `no turn is left in flight (${fault.name})`);
    assert.equal(existsSync(spawnFile), false, `and no runtime was spawned for the refused prompt (${fault.name})`);
    assert.throws(() => bridge.status("builder"), /No session named/, `and no record was set for the name (${fault.name})`);
    if (before !== undefined) assert.ok(readFileSync(stateFile).equals(before), `the file's bytes are untouched (${fault.name})`);
    for (const line of logged) {
      assert.ok(!line.includes(workspace), `no log line names the path (${fault.name}): ${line}`);
      assert.ok(!line.includes(secret), `or the bytes (${fault.name}): ${line}`);
    }
    // Nothing reached disk, so nothing is taken back from it: a release would read the same unreadable
    // file and log a line about a record this process wrote nowhere.
    assert.ok(!logged.some((line) => line.includes("could not be taken back")), `no release is attempted over a record that never reached disk (${fault.name}): ${logged.join(" | ")}`);

    // The control: the same bridge prompts the same name once the file is repaired, so the refusals
    // above are the unreadable file rather than a bridge that has stopped prompting, and the spawn
    // marker speaks, so its absence above was a spawn that did not happen rather than a marker that
    // does not work.
    rmSync(stateFile, { recursive: true, force: true });
    writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: {} }));
    const taken = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
    assert.match(taken.sessionId, /^session-[0-9a-f]{32}$/, `a repaired map admits the prompt (${fault.name})`);
    assert.equal(scopeOnDisk(stateFile, workspace).builder.sessionId, taken.sessionId, `and the record is on disk (${fault.name})`);
    assert.equal(existsSync(spawnFile), true, `and the runtime was spawned for it (${fault.name})`);
    await bridge.close();
  }
});

test("the turn-end count write stays best effort when the map turns unreadable under the turn", async (t) => {
  // The prompt's write refuses on a read that failed, and the write at the turn's end does not: that
  // turn is over, its event is the one thing this bridge exists to deliver, and a lost count harms
  // nobody. So a map that turns unreadable between the prompt and the turn's end costs the count, is
  // said in the log by its role, and neither throws into the notification pump nor loses the push.
  const { bridge, pushed, logged, workspace, stateFile } = stand(t, ["--stop-before-idle"]);
  const secret = "the-file-bytes-nobody-should-read";

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().busy, "the turn to be in flight");
  assert.match(scopeOnDisk(stateFile, workspace).builder.sessionId, /^session-[0-9a-f]{32}$/, "the record reached disk before the map was damaged");
  const damaged = `{ not json ${secret}`;
  writeFileSync(stateFile, damaged);

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, ["builder"], "the turn in flight is ended and reported");
  assert.equal(pushed.length, 1, "as one event, delivered whatever the map did");
  assert.equal(readFileSync(stateFile, "utf8"), damaged, "and the damaged map is left exactly as it was rather than replaced by this scope alone");
  const unwritten = logged.find((line) => line.includes("session map could not be written"));
  assert.ok(unwritten !== undefined, `the lost count is said: ${logged.join(" | ")}`);
  // With the reader's own reason, since a parse failure carries no filesystem code and a line saying
  // "no code" tells the operator reading it that a count was lost and nothing about why.
  assert.match(unwritten, /\(not-json\)/, `and why: ${unwritten}`);
  for (const line of logged) {
    assert.ok(!line.includes(secret), `no log line carries the file's bytes: ${line}`);
  }
});

test("the default scope folds a Windows path's case as the workspace comparison does", () => {
  // A project can be launched with its path spelled in two cases across two sessions, and Windows
  // names one directory by both. Keyed on the spelling, a restart under the other casing would land
  // in a second scope and not find the records the first wrote. The fold is the one the workspace
  // comparison applies, so a scope and a workspace cannot come to disagree about which paths are one
  // place.
  if (process.platform === "win32") {
    assert.equal(defaultScope("C:\\Projects\\Worker"), defaultScope("c:\\projects\\worker"), "two spellings of one directory are one scope");
    assert.equal(defaultScope("C:\\Projects\\Worker"), defaultScope("c:\\projects\\worker\\"), "with or without a trailing separator");
  } else {
    assert.notEqual(defaultScope("/projects/worker"), defaultScope("/Projects/Worker"), "on a case-sensitive filesystem two spellings are two directories");
  }
  // The control: a path is its own scope, resolved, on every platform.
  assert.equal(defaultScope(os.tmpdir()), defaultScope(path.join(os.tmpdir(), ".")), "a path resolves to itself");
});

test("status and tail read the record off the file, so a neighbour's advance of a name is what they report", async (t) => {
  // Another bridge in the scope can take a name this one merely loaded and drive it on: the count and
  // the session id on disk are then the session's, and a status answered from this bridge's copy
  // would report a count that is no longer anyone's. The neighbour is stood in for by a write to the
  // file, and the log is seeded for the id it wrote, so a tail that reads the copy finds no log while
  // one that reads the file finds the neighbour's.
  const { workspace, stateFile, own } = stand(t);
  const before = "session-0123456789abcdef0123456789abcdef";
  const after = "session-fedcba9876543210fedcba9876543210";
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: { sessionId: before, cwd: workspace, turn: 0 } } } }));
  const bridge = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );
  assert.equal(bridge.status("builder").sessionId, before, "the bridge loaded the record as it was");

  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: { sessionId: after, cwd: workspace, turn: 5 } } } }));
  const directory = path.join(workspace, "home", "sessions", "a-workspace-key", after);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "session.jsonl.zstd"), Buffer.alloc(0));

  const status = bridge.status("builder");
  assert.equal(status.sessionId, after, "status names the session id the file carries now");
  assert.equal(status.turn, 5, "and the count the neighbour advanced it to");
  assert.equal(status.state, "stored", "while the runtime state is this bridge's own, which holds none");
  assert.deepEqual(bridge.tail("builder"), [], "and tail opens the log of the id the file carries, which is empty rather than absent");
});

test("a runtime that dies under the prompt request is reported as stopped or lost, whichever side learns it first", async (t) => {
  // The transport closes under the request and the notification stream ends, and which of the two
  // reaches the bridge first is the scheduler's to pick. Either way the model is owed the bridge's
  // sentence rather than the SDK's closed-transport text, which reads as a broken bridge, and no
  // turn is left in flight for a worker that is gone.
  const { bridge, pushed, workspace } = stand(t, ["--die-on-second-prompt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the first turn to end");

  await assert.rejects(
    bridge.prompt({ session: "builder", text: "and again" }),
    /stopped or lost while it was taking this prompt/,
    "the caller is told the worker went away, in the bridge's words",
  );
  await until(() => bridge.status("builder").state === "stored", "the dead runtime to be reaped");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "no turn is left in flight");

  // The control: the name prompts again on a fresh worker, and the turn the runtime never took was
  // not counted, whichever side reported it.
  const before = pushed.length;
  const again = await bridge.prompt({ session: "builder", text: "once more" });
  assert.equal(again.turn, 2);
  await until(() => pushed.length > before, "the turn on the fresh worker to end");
  assert.equal(pushed[pushed.length - 1].params.meta.kind, "turn_end");
});

test("a successor prompted the moment a loss clears the turn keeps its routing when the lost request's rejection lands", async (t) => {
  // The request the runtime died under is rejected by the SDK once the child's streams have settled,
  // and its rejection reverts what the failed call registered, the routing from the session id to
  // the name among it. A successor for the same name registers the same id, so a revert that read
  // "the routing still points at my name" as "the routing is still mine" would delete the
  // successor's and leave it a turn nothing can end. The ordering pinned here is that the successor
  // gets its event whichever lands first: the rejection is delivered as the transport closes, while
  // the successor waits out the loss and then a spawn before it registers, and the revert leaves the
  // routing alone while the name has a turn in flight regardless.
  const { bridge, pushed, workspace, logged } = stand(t, ["--die-on-second-prompt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the first turn to end");

  const dying = bridge.prompt({ session: "builder", text: "and again" }).then(
    () => "accepted",
    (error: unknown) => String(error),
  );
  // The successor is prompted at the loss line the bridge logs when the stream ends, which is written
  // in both orderings and before the dead runtime is reaped; the dying turn's own in-flight window is
  // a few milliseconds wide, too narrow to wait on.
  await until(() => logged.some((line) => line.includes("notification stream ended")), "the loss to be noticed");
  const successor = bridge.prompt({ session: "builder", text: "once more" });

  assert.match(await dying, /stopped or lost/, "the request the runtime died under is told so");
  const receipt = await successor;
  assert.equal(receipt.turn, 2, "the successor runs on a fresh worker, counted after the turn the runtime never took");
  // The dying turn is itself reported as a lost turn when the stream's end is what the bridge learns
  // first, so the successor's event is found by its kind rather than by its position.
  await until(() => pushed.slice(1).some((event) => event.params.meta.kind === "turn_end"), "the successor's turn to end");
  assert.equal(bridge.status("builder").state, "live", "the session is still routed to the live runtime");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "and nothing is left in flight");
});

test("a log sink that throws does not end the notification stream", async (t) => {
  // Every notification is read inside a guard, so one that cannot be read costs one notification
  // rather than the stream. The guard reports through the log sink, and a sink that throws would
  // otherwise leave the loop from inside the guard that exists to keep it: the subscription stays
  // open on a live runtime that nothing reads, every turn in flight waits on an idle nobody sees,
  // and the loss handler never runs because the stream never ended. The stand-in sends an idle
  // before the receipt, which the bridge says out loud through the sink; that line is what throws.
  const { workspace, stateFile, own } = stand(t);
  const pushed: ChannelNotification[] = [];
  const bridge = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN, "--idle-before-receipt"], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: (notification) => {
        pushed.push(notification);
      },
      log: () => {
        throw new Error("the sink is closed");
      },
    }),
  );

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end with its event, the stream having survived the sink");

  assert.equal(onlyEvent(pushed).meta.kind, "turn_end");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] });
});

test("a scope keyed like a prototype property survives another bridge's write", (t) => {
  // Scope keys are directory paths off disk laid onto an object. On an ordinary object a key spelled
  // `__proto__` sets the prototype rather than an own property, and that scope would vanish from the
  // file on the next write with nothing said to the bridge that owns it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-proto-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "sessions.json");
  const stranger = { theirs: { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: dir, turn: 1 } };
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { ["__proto__"]: stranger } }));

  writeState(stateFile, dir, new Map([["mine", { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: dir, turn: 2 }]]));

  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, unknown> };
  assert.ok(Object.hasOwn(persisted.scopes, "__proto__"), "the stranger's scope is still in the file");
  assert.deepEqual(Object.getOwnPropertyDescriptor(persisted.scopes, "__proto__")?.value, stranger, "as it was written");
  // The control: this bridge's own scope landed beside it, and the stranger's is readable by name.
  assert.deepEqual([...readState(stateFile, dir).keys()], ["mine"]);
  assert.equal(readState(stateFile, "__proto__").get("theirs")?.turn, 1);
});

test("an idle held for a message queued ahead does not close this turn once its own receipt is confirmed", async (t) => {
  // The session was already working when the prompt arrived: a message queued ahead of this one is
  // spliced and runs to its idle before this prompt's own receipt. That idle arrives while the
  // prompt request is still out, so it is held against the id the request will return. Then this
  // turn's own splice arrives, and then the request returns. A bridge that carried the held idle
  // across its own splice would read the confirmation, take that idle for this turn's end, and push
  // an empty body while the worker was still writing the real answer, which would then arrive to
  // find no turn left: the lost final response this section names as its expensive failure.
  //
  // The stand-in answers the request only once this turn's receipt is on the wire, and holds the
  // rest of the turn until the go-file exists, which is written here after the prompt call has
  // returned. The ordering under test is produced rather than raced for: the bridge has read the
  // receipt and the held idle before it learns its own id, and has learned its own id before the
  // turn's real idle exists.
  const goDir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-go-"));
  t.after(() => rmSync(goDir, { recursive: true, force: true }));
  const go = path.join(goDir, "go");
  const { bridge, pushed, workspace, replays } = stand(t, ["--queued-ahead", "--answer-after-receipt", "--go-file", go]);

  const receipt = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });

  assert.equal(receipt.turn, 1);
  assert.equal(pushed.length, 0, "the held idle closed the queued message's stretch, and confirming this turn released nothing");
  assert.deepEqual(bridge.busy(), { busy: true, sessions: ["builder"] }, "this turn is still in flight, waiting on its own idle");

  writeFileSync(go, "");
  await until(() => pushed.length > 0, "the turn's own idle to end it");
  await until(() => replays() >= 1, "the replay to end");

  const event = onlyEvent(pushed);
  assert.equal(event.meta.kind, "turn_end", "the event is this turn's own ending, not the queued message's idle");
  assert.equal(event.meta.finish_reason, "completed");
  assert.match(event.content, /hello-from-qwen\.txt/, "and it carries the worker's answer rather than an empty body");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] });
});

test("a runtime lost mid-turn reports the turn as an error, and a prompt arriving at once still gets a fresh worker", async (t) => {
  // The stream ends with a turn in flight. Silence there is the failure the channel exists to
  // prevent, so the turn is reported as lost; the next prompt spawns a fresh runtime, and one that
  // arrives while the dead runtime is still being reaped waits for the reaping rather than spawning
  // beside it. The wait itself has no seam a test can see, so what is pinned is the path around it:
  // the report, the log line, and the prompt that follows running to its own event.
  const { bridge, pushed, workspace, logged } = stand(t, ["--die-after-receipt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the lost turn to be reported");

  assert.equal(pushed[0].params.meta.kind, "error");
  assert.equal(pushed[0].params.meta.finish_reason, "runtime-lost");
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "a lost turn is not left in flight");
  assert.ok(logged.some((line) => line.includes("notification stream ended")), `the loss is said out loud: ${logged.join(" | ")}`);
  assert.equal(bridge.status("builder").state, "stored", "with the runtime gone the session is stored");

  const again = await bridge.prompt({ session: "builder", text: "and again", cwd: workspace });
  assert.equal(again.turn, 2, "the lost turn was accepted by its runtime, so it is counted");
  await until(() => pushed.length > 1, "the turn on the fresh worker to end");
  assert.equal(pushed[1].params.meta.kind, "turn_end");
  assert.equal(bridge.status("builder").state, "live");
});

test("a prompt the runtime refuses for a session with a turn behind it leaves the session live and its record whole", async (t) => {
  // The routing from the session id to its name was set by the first turn and the runtime that ran
  // it is still up, so a refused second prompt is not a reason to forget where notifications for
  // that id go: a bridge that removed the entry would report the session as stored while its worker
  // runs and drop whatever the runtime said about it next.
  const { bridge, pushed, workspace } = stand(t, ["--refuse-second-prompt"]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the first turn to end");

  await assert.rejects(bridge.prompt({ session: "builder", text: "and again" }), /refused this prompt/);

  const status = bridge.status("builder");
  assert.equal(status.state, "live", "the routing the first turn set is not the refused call's to remove");
  assert.equal(status.turn, 1, "and the record is the one the finished turn wrote");
  assert.equal(status.inFlight, false);

  // The control: the stand-in refuses the second prompt alone, so a third runs on the same runtime
  // and the routing above is what delivers its event.
  const third = await bridge.prompt({ session: "builder", text: "once more" });
  assert.equal(third.turn, 2);
  await until(() => pushed.length > 1, "the third prompt's turn to end");
  assert.equal(pushed[1].params.meta.kind, "turn_end");
});

test("a written path with no spelling relative to the workspace is counted, never named in this machine's shape", async (t) => {
  // The receipt promises paths relative to the workspace. A path rooted at no drive is absolute to
  // `path.isAbsolute` on Windows and resolves against whichever drive this process runs from, so
  // `path.relative` would spell it as a `..\` chain naming a place the worker never wrote; a path on
  // another drive comes back from `path.relative` unchanged, which is an absolute path of this
  // machine's in an attribute that promised the workspace's; and a path outside the workspace on its
  // own drive has a relative spelling that leaves the workspace and then names the rest of this
  // machine, an account's home directory among the places it can name. All are counted in the `+N`
  // tail. On POSIX the rootless spelling is that third shape, an ordinary absolute path outside the
  // workspace, so the same string is counted on both platforms for the two different reasons.
  const rootless = process.platform === "win32" ? "\\elsewhere\\x.txt" : "/elsewhere/x.txt";
  const { bridge, pushed, workspace } = stand(t, ["--foreign-file", rootless]);

  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  const value = onlyEvent(pushed).meta.files_touched;
  assert.equal(value, "hello-from-qwen.txt,+1", `a path outside the workspace is counted rather than spelled: ${value}`);

  // The same shape on this platform's own spelling: a same-drive absolute path outside the
  // workspace, whose relative spelling would begin with a parent-directory segment.
  const outside = stand(t, ["--foreign-file", path.join(path.dirname(os.tmpdir()), "outside-the-workspace", "config")]);
  await outside.bridge.prompt({ session: "builder", text: "make a file", cwd: outside.workspace });
  await until(() => outside.pushed.length > 0, "the turn to end");
  assert.equal(onlyEvent(outside.pushed).meta.files_touched, "hello-from-qwen.txt,+1", "a same-drive path outside the workspace is counted rather than spelled");
  // The same place spelled relatively. A relative path is the worker's own spelling, and one that
  // begins by leaving the workspace names the rest of this machine exactly as the absolute spelling
  // above does; carried as written it would put that spelling into the attribute the absolute branch
  // counts it out of. One rule, both spellings.
  const climbing = stand(t, ["--foreign-file", path.join("..", "..", "outside-the-workspace", "config")]);
  await climbing.bridge.prompt({ session: "builder", text: "make a file", cwd: climbing.workspace });
  await until(() => climbing.pushed.length > 0, "the turn to end");
  assert.equal(onlyEvent(climbing.pushed).meta.files_touched, "hello-from-qwen.txt,+1", "a relative path that leaves the workspace is counted rather than spelled");
  // The control for the relative branch: a parent-directory segment that stays inside the workspace
  // is spelled, resolved, so the count above is the leaving and not the `..` itself.
  // Joined by hand, since `path.join` would fold the `..` away before the worker ever spelled it.
  const staying = stand(t, ["--foreign-file", ["nested", "..", "in-the-workspace.txt"].join(path.sep)]);
  await staying.bridge.prompt({ session: "builder", text: "make a file", cwd: staying.workspace });
  await until(() => staying.pushed.length > 0, "the turn to end");
  assert.equal(onlyEvent(staying.pushed).meta.files_touched, "in-the-workspace.txt,hello-from-qwen.txt", "a relative path that stays inside the workspace is spelled, resolved");
  // The control: a same-drive absolute path inside the workspace is spelled relative to it, so the
  // count above is the parent-directory rule rather than every absolute path being counted.
  const spelled = stand(t, (dir) => ["--foreign-file", path.join(dir, "nested", "in-the-workspace.txt")]);
  await spelled.bridge.prompt({ session: "builder", text: "make a file", cwd: spelled.workspace });
  await until(() => spelled.pushed.length > 0, "the turn to end");
  assert.equal(onlyEvent(spelled.pushed).meta.files_touched, `${path.join("nested", "in-the-workspace.txt")},hello-from-qwen.txt`, "an absolute path inside the workspace is spelled relative to it");

  if (process.platform === "win32") {
    const other = stand(t, ["--foreign-file", "Q:\\elsewhere\\x.txt"]);
    await other.bridge.prompt({ session: "builder", text: "make a file", cwd: other.workspace });
    await until(() => other.pushed.length > 0, "the turn to end");
    assert.equal(onlyEvent(other.pushed).meta.files_touched, "hello-from-qwen.txt,+1", "a path on another drive is counted rather than spelled");

    // A drive-relative path, a drive letter and a colon with no separator after them, is not absolute
    // to `path.isAbsolute` and names a place against that drive's current directory rather than the
    // workspace; carried as written it would be spelled as a workspace path it is not.
    const relative = stand(t, ["--foreign-file", "Q:elsewhere\\x.txt"]);
    await relative.bridge.prompt({ session: "builder", text: "make a file", cwd: relative.workspace });
    await until(() => relative.pushed.length > 0, "the turn to end");
    assert.equal(onlyEvent(relative.pushed).meta.files_touched, "hello-from-qwen.txt,+1", "a drive-relative path is counted rather than spelled");
  }
});

test("a state file grown past the ceiling is refused whole rather than read into memory", (t) => {
  // The file is read whole at construction and twice per write, and it is a file anything running
  // as this user can grow. Past the ceiling it is reported and treated as unreadable, which costs
  // every name its `cwd` on the next prompt, where reading it would cost the process whatever its
  // writer chose.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "sessions.json");
  const records = { builder: { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: dir, turn: 1 } };
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [dir]: records }, padding: "x".repeat(MAX_STATE_BYTES) }));
  const logged: string[] = [];

  const sessions = readState(stateFile, dir, (line) => logged.push(line));

  assert.deepEqual([...sessions.keys()], [], "nothing is remembered out of a file past the ceiling");
  assert.ok(
    logged.some((line) => line.includes("past the") && line.includes(String(MAX_STATE_BYTES))),
    `the refusal names the ceiling: ${logged.join(" | ")}`,
  );

  // The control: the same records under the ceiling are read, so the emptiness above is the ceiling
  // rather than a reader that has stopped reading.
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [dir]: records } }));
  assert.deepEqual([...readState(stateFile, dir, () => undefined).keys()], ["builder"]);
});

test("a write refuses to replace a session map it cannot read, so another bridge's scopes are not deleted by it", (t) => {
  // The write re-reads the file to carry the other scopes through, and a file that is present but
  // past the ceiling, not JSON, or not a session map reads as empty: the rename would then replace
  // every other bridge's records with this one scope, records that were readable by a person and
  // refused by this version's rules rather than lost to damage, and the process that destroyed them
  // is not the one that logged a warning about them. So the write refuses and the file stays whole.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "sessions.json");
  const mine = new Map([["builder", { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: dir, turn: 1 }]]);
  const stranger = { theirs: { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: dir, turn: 4 } };
  const unreadable = [
    JSON.stringify({ version: 2, scopes: { "a-stranger-scope": stranger }, padding: "x".repeat(MAX_STATE_BYTES) }),
    "{ not json",
    JSON.stringify({ version: 3, records: { "a-stranger-scope": stranger } }),
  ];
  for (const content of unreadable) {
    writeFileSync(stateFile, content);
    const logged: string[] = [];
    assert.throws(
      () => writeState(stateFile, dir, mine, (line) => logged.push(line)),
      /cannot be read/,
      `a file of ${String(content.length)} bytes that this version cannot read is refused`,
    );
    assert.equal(readFileSync(stateFile, "utf8"), content, "and left exactly as it was");
    assert.deepEqual(readdirSync(dir), ["sessions.json"], "with no temporary file left beside it");
  }

  // The control: a session map this version reads is merged and written, and an absent file is
  // created, so the refusals above are the unreadable file rather than a write that never works.
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { "a-stranger-scope": stranger } }));
  writeState(stateFile, dir, mine);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, { turn: number }>> };
  assert.deepEqual(persisted.scopes["a-stranger-scope"], stranger);
  assert.equal(persisted.scopes[dir].builder.turn, 1);
  rmSync(stateFile);
  writeState(stateFile, dir, mine);
  assert.ok(existsSync(stateFile));
});

test("the runtime spec reads its own values from the environment it is handed", () => {
  // `startBridge(env)` injects an environment so a test can stand the bridge up without the
  // machine's own, and the spec is one of the readers: a spec that read `process.env` for its api
  // key while the state file came from the injected one would leave that seam covering half the
  // surface. The scrubbed base the child starts from is the vendor's read of the process environment
  // and takes no injection, so what is pinned is the value this spec reads itself.
  const home = path.join(os.tmpdir(), "dsh-home");

  const handed = dshRuntimeSpec(home, { OLLAMA_API_KEY: "handed-in" });

  assert.equal(handed.env.OLLAMA_API_KEY, "handed-in");
  assert.equal(handed.env.DSH_HOME, home);
  // Under an environment with no key, none reaches the child, whatever this process carries: the
  // vendor's scrub drops every key-shaped name, so the only route in is the one the spec reads.
  assert.equal(dshRuntimeSpec(home, {}).env.OLLAMA_API_KEY, undefined);
});

test("a name given another conversation in the file refuses the prompt that would lay this bridge's over it, and the next prompt resumes the file's", async (t) => {
  // The write is a compare-and-set on the conversation identifier. This bridge ran a turn under the
  // name, so it answers the name from its own copy; the file is then given another DSH session id
  // under the name, standing for another writer. The prompt that would lay this bridge's id over it
  // is refused, nothing is written, and the refusal drops this bridge's claim to the name, which is
  // what makes its advice true: the next prompt reads the file and resumes the conversation it names.
  // The refusal names no process and carries no path, since it knows neither.
  const { bridge, pushed, workspace, stateFile } = stand(t);
  const mine = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "this bridge's turn to end");
  assert.equal(scopeOnDisk(stateFile, workspace).builder.sessionId, mine.sessionId, "this bridge's conversation is on disk");

  const theirs = { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: workspace, turn: 5 };
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: theirs } } }));

  let refusal = "";
  await assert.rejects(
    bridge.prompt({ session: "builder", text: "and again" }),
    (error: Error) => {
      refusal = error.message;
      return /was not prompted/.test(refusal) && /different DSH conversation/.test(refusal) && /prompt the name again/i.test(refusal);
    },
    `the write refuses to lay this bridge's id over another conversation, and says what to do: ${refusal}`,
  );
  assert.ok(!refusal.includes(workspace), `the refusal names no path: ${refusal}`);
  assert.deepEqual(bridge.busy(), { busy: false, sessions: [] }, "no turn is left in flight for the refused prompt");
  assert.deepEqual(scopeOnDisk(stateFile, workspace).builder, theirs, "and the file's record is left exactly as it was");

  const resumed = await bridge.prompt({ session: "builder", text: "and again" });
  assert.equal(resumed.sessionId, theirs.sessionId, "the next prompt resumes the conversation the file names");
  assert.notEqual(resumed.sessionId, mine.sessionId, "and not the one this bridge was refused for");
  assert.equal(resumed.turn, theirs.turn + 1, "counting on from the file's count");
  assert.equal(bridge.status("builder").sessionId, theirs.sessionId, "which is now the name this bridge answers for");
});

test("a turn ending after the name was given another conversation loses its count, leaves the file's record, and the next prompt resumes it", async (t) => {
  // The write at the turn's end is the same compare-and-set, best effort: the count is not written
  // against a conversation this bridge is not running, the loss is said in the log with why, and the
  // claim to the name is dropped so the next prompt reads the file rather than refusing again.
  const { bridge, pushed, logged, workspace, stateFile } = stand(t, ["--stop-before-idle"]);
  const mine = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => bridge.busy().busy, "the turn to be in flight");
  const theirs = { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: workspace, turn: 7 };
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: theirs } } }));

  const killed = await bridge.kill("builder");

  assert.deepEqual(killed.killed, ["builder"], "the turn in flight is ended and reported");
  assert.equal(pushed.length, 1, "as one event");
  assert.deepEqual(scopeOnDisk(stateFile, workspace).builder, theirs, "the file's record is left exactly as it was, count and all");
  assert.ok(
    logged.some((line) => line.includes("not written") && line.includes("different conversation")),
    `the count that was not written is said, with why: ${logged.join(" | ")}`,
  );
  const resumed = await bridge.prompt({ session: "builder", text: "and again" });
  assert.equal(resumed.sessionId, theirs.sessionId, "the next prompt resumes the conversation the file names");
  assert.notEqual(resumed.sessionId, mine.sessionId);
  assert.equal(resumed.turn, theirs.turn + 1, "counting on from the file's count");
});

test("a write lays a name down where the entry is absent, names the same conversation, or is no session, and reports the rest as superseded", (t) => {
  // The compare-and-set's three rules, on the raw entries as the write sees them. No entry, and an
  // entry the reader would not admit as a session, are free: treated as another conversation an
  // inadmissible entry could never be replaced, since the reader drops it, the next prompt mints a
  // fresh id, and the write would refuse it again. An entry naming the same id is the same
  // conversation. An entry naming another admissible id is left exactly as it is and reported.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-cas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "sessions.json");
  const id = (digit: string): string => `session-${digit.repeat(32)}`;
  const moved = { sessionId: id("c"), cwd: dir, turn: 5 };
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      scopes: {
        [dir]: {
          same: { sessionId: id("a"), cwd: dir, turn: 1 },
          garbage: { sessionId: "not-a-session-id", cwd: dir, turn: 1 },
          unstrung: { sessionId: 42, cwd: dir, turn: 1 },
          moved,
        },
      },
    }),
  );
  const mine = (sessionId: string): SessionRecord => ({ sessionId, cwd: dir, turn: 9 });
  const written = new Map([
    ["fresh", mine(id("1"))],
    ["same", mine(id("a"))],
    ["garbage", mine(id("2"))],
    ["unstrung", mine(id("3"))],
    ["moved", mine(id("4"))],
  ]);
  const logged: string[] = [];

  const superseded = writeState(stateFile, dir, written, (line) => logged.push(line));

  assert.deepEqual([...superseded], ["moved"], "the one name whose entry names another conversation is reported, and only that one");
  const after = scopeOnDisk(stateFile, dir);
  assert.deepEqual(after.moved, moved, "and its entry is left exactly as it was");
  for (const name of ["fresh", "same", "garbage", "unstrung"]) {
    assert.deepEqual(after[name], written.get(name), `'${name}' carries the record this write laid down`);
  }
  assert.ok(logged.some((line) => line.includes("'moved'") && line.includes("different conversation")), `the loss is said with why: ${logged.join(" | ")}`);
  assert.ok(!logged.some((line) => line.includes(dir)), `and no line names the path: ${logged.join(" | ")}`);
});

test("a write that read the file as absent creates it exclusively, and a file that appears in between is read again rather than replaced", (t) => {
  // Absent is the one reading under which this scope alone becomes the whole file, so it is published
  // with an exclusive create rather than a rename: a file that is there by the time of the write, put
  // there by a neighbour between the read and the write, refuses the create, and the write runs once
  // more from a fresh read that carries the neighbour's scope through. The neighbour is stood in for
  // by the map's own iteration, which is the one point inside the write between its read and its
  // publication that a test can reach.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-wx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "state", "sessions.json");
  const theirs = { sessionId: "session-fedcba9876543210fedcba9876543210", cwd: dir, turn: 3 };
  const mine: SessionRecord = { sessionId: "session-0123456789abcdef0123456789abcdef", cwd: dir, turn: 1 };
  const written = new Map<string, SessionRecord>([["mine", mine]]);
  let passes = 0;
  const iterate = written[Symbol.iterator].bind(written);
  written[Symbol.iterator] = () => {
    passes += 1;
    if (passes === 1) {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { "a-neighbour-scope": { theirs } } }));
    }
    return iterate();
  };

  const superseded = writeState(stateFile, dir, written);

  assert.equal(passes, 2, "the edit ran once over the absent reading and once over the file that appeared");
  assert.deepEqual([...superseded], [], "and nothing was superseded");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { scopes: Record<string, Record<string, unknown>> };
  assert.deepEqual(persisted.scopes["a-neighbour-scope"], { theirs }, "the neighbour's scope survives, since the create refused and the second pass carried it");
  assert.deepEqual(persisted.scopes[dir], { mine }, "and this scope's record landed beside it");

  // The control: the same write over no file at all creates it in one pass.
  const alone = path.join(dir, "alone", "sessions.json");
  writeState(alone, dir, new Map([["mine", mine]]));
  assert.deepEqual((JSON.parse(readFileSync(alone, "utf8")) as { scopes: Record<string, unknown> }).scopes, { [dir]: { mine } });
});

test("a tail whose log cannot be found is refused by the failure's code and never by the path it was raised on", (t) => {
  // Finding the log lists directories under the harness home, and a listing that fails raises an
  // error naming that path, which runs through the operator's user name. The listing is inside the
  // same guard as the read, so the model reads the code and the next move rather than the path;
  // `status` degrades on the same failure and carries the same words.
  const { workspace, stateFile, own } = stand(t);
  const sessionId = "session-0123456789abcdef0123456789abcdef";
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: { sessionId, cwd: workspace, turn: 1 } } } }));
  const home = path.join(workspace, "home");
  mkdirSync(home, { recursive: true });
  // A regular file where the sessions directory is listed from, so the listing itself fails.
  writeFileSync(path.join(home, "sessions"), "not a directory");
  const bridge = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home,
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );

  let refusal = "";
  assert.throws(
    () => bridge.tail("builder"),
    (error: Error) => {
      refusal = error.message;
      return /the log could not be read \(E[A-Z]+\)/.test(refusal);
    },
    `the failure is said by its code: ${refusal}`,
  );
  assert.ok(!refusal.includes(workspace), `and not by the path it was raised on: ${refusal}`);
  const status = bridge.status("builder");
  assert.match(status.logUnread ?? "", /the log could not be read \(E[A-Z]+\)/, "status degrades on the same failure");
  assert.ok(!(status.logUnread ?? "").includes(workspace), "and names no path either");
  assert.equal(status.sessionId, sessionId, "while the record's own fields are reported");
});

test("an entry the reader will not admit is free to the write, so a name carrying one is written over and prompts", async (t) => {
  // The reader admits an entry only as a session record it can use: an object with a DSH session id
  // and a workspace this bridge will open. The write compares conversation identifiers by the same
  // predicate. Judged by the id alone, an entry with a sound id and a workspace the reader refuses
  // would be another conversation to the write and no conversation to the reader: the prompt would
  // mint an id, the write would refuse it, the refusal would drop the claim and send the caller to
  // prompt again, and the next prompt would do the same, for as long as the entry stood.
  const { bridge, pushed, workspace, stateFile, logged } = stand(t);
  const stored = "session-0123456789abcdef0123456789abcdef";
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { remote: { sessionId: stored, cwd: "\\\\host\\share\\x", turn: 4 } } } }));

  const receipt = await bridge.prompt({ session: "remote", text: "make a file", cwd: workspace });
  await until(() => pushed.length > 0, "the turn to end");

  assert.notEqual(receipt.sessionId, stored, "the name was minted afresh, since the entry named no workspace this bridge will open");
  assert.equal(receipt.turn, 1, "and its count starts over rather than continuing the entry's");
  const after = scopeOnDisk(stateFile, workspace).remote;
  assert.equal(after.sessionId, receipt.sessionId, "the write laid this bridge's record over the entry rather than refusing it");
  assert.equal(after.cwd, workspace);
  assert.ok(logged.some((line) => line.includes("'remote'") && line.includes("names no local workspace")), `the reader said why the entry was no session: ${logged.join(" | ")}`);
  assert.ok(!logged.some((line) => line.includes("different conversation")), `and the write refused nothing: ${logged.join(" | ")}`);
  assert.ok(!logged.some((line) => line.includes("\\\\host\\share")), "no line names the entry's path");
});

test("a prompt over a map that cannot be read is refused for the map before the name is looked up, so the caller is not sent for a cwd", async (t) => {
  // The name is recalled through a reader that folds an unread map into no records, so while the
  // file stays so a name whose record is on it reads as new. Refused for the missing cwd first, the
  // caller would be told the name is new, which is false, and to supply a cwd, which helps nothing,
  // since the write refuses the same map on the next call. The map is read before the name is, so
  // the fault present is the one named.
  const { bridge, stateFile } = stand(t);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, "{ not json");

  let refusal = "";
  await assert.rejects(
    bridge.prompt({ session: "builder", text: "make a file" }),
    (error: Error) => {
      refusal = error.message;
      return /does not parse/.test(refusal);
    },
    `the refusal names the unreadable map: ${refusal}`,
  );
  assert.ok(!/needs its cwd/.test(refusal) && !/is new/.test(refusal), `and not a missing cwd: ${refusal}`);

  // The control: with the map repaired, the same call is refused for the cwd it really lacks.
  rmSync(stateFile, { force: true });
  await assert.rejects(bridge.prompt({ session: "builder", text: "make a file" }), /is new, so dsh_prompt needs its cwd/, "so the refusal above was the map's and not the name's");
});

test("a turn the runtime numbers behind the stored count brings the count to the runtime's number, so the next receipt names the turn the runtime runs next", async (t) => {
  // The runtime's numbering is authoritative in both directions. A turn ended unattributed is counted
  // for a runtime that may never have run it, so the stored count can sit ahead of the runtime; a
  // count that only moved upward would stay where that turn left it, and every receipt after it would
  // name the same turn. The stand-in numbers its turn as the test says.
  const { bridge, pushed, workspace, stateFile } = stand(t, ["--turn-start", "2"]);
  const sessionId = "session-0123456789abcdef0123456789abcdef";
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: { builder: { sessionId, cwd: workspace, turn: 7 } } } }));

  const first = await bridge.prompt({ session: "builder", text: "make a file" });
  assert.equal(first.turn, 8, "the receipt names the turn after the stored count, which is all the bridge knows before the runtime speaks");
  await until(() => pushed.length > 0, "the first turn to end");
  assert.equal(pushed[0].params.meta.turn, "2", "the event carries the runtime's own number");
  assert.equal(bridge.status("builder").turn, 2, "and the count is the runtime's, behind where the file had it");
  assert.equal(scopeOnDisk(stateFile, workspace).builder.turn, 2, "on disk as well");

  const second = await bridge.prompt({ session: "builder", text: "and again" });
  await until(() => pushed.length > 1, "the second turn to end");
  assert.equal(second.turn, 3, "so the next receipt names the turn the runtime runs next rather than the stored count again");
});

test("a file full of refused records does not mute the reader about the file itself", async (t) => {
  // The reader says each distinct line once and bounds the lines about records, since the file is one
  // anything running as this user can fill with records to refuse. A line about the file, that it
  // does not parse or cannot be read, is outside that bound: bounded with the rest, a file holding
  // more refused records than the bound would leave the reader silent about the file for the life of
  // the process, and the one line the operator needs would be the one not said.
  const { workspace, stateFile, own } = stand(t);
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < MAX_STATE_DIAGNOSTICS + 1; i += 1) entries[`bad-${String(i)}`] = { sessionId: "not-a-session-id", cwd: workspace, turn: 1 };
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, scopes: { [workspace]: entries } }));
  const logged: string[] = [];
  const bridge = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: (line) => logged.push(line),
    }),
  );
  assert.equal(logged.filter((line) => line.includes("names no DSH session id")).length, MAX_STATE_DIAGNOSTICS, "the lines about records stop at the bound");

  writeFileSync(stateFile, "{ not json");
  await assert.rejects(bridge.prompt({ session: "builder", text: "make a file", cwd: workspace }), /does not parse/);
  assert.ok(logged.some((line) => line.includes("does not parse")), `the line about the file is said past the bound: ${logged.join(" | ")}`);
});

test("a record whose shape the workspace guard refuses is refused before any runtime is spawned", async (t) => {
  // Section 3's own field: validated the same way `cwd` is and before the same spawn, since a value
  // this write is about to persist to the state file is a path this bridge later joins into a
  // filesystem call, exactly as `admittedRecord` treats one already on disk. "Before any runtime is
  // spawned" is measured rather than only claimed by the title: the stand-in's own replay count stays
  // at zero across every refusal below.
  const { bridge, workspace, replays } = stand(t);
  const asDirectory = path.join(workspace, "already-a-directory");
  mkdirSync(asDirectory);

  for (const refused of ["relative/record.md", "\\\\attacker\\share\\x", "  ", asDirectory]) {
    await assert.rejects(
      bridge.prompt({ session: "builder", text: "make a file", cwd: workspace, record: refused }),
      /record .* does not name a file on this machine/,
      `${JSON.stringify(refused)} must be refused as a path`,
    );
    assert.equal(replays(), 0, `no runtime ran for ${JSON.stringify(refused)}`);
  }
  // The control: an absolute local path on the same call is accepted, so the refusals above are the
  // guard rather than a prompt that has stopped taking a record at all.
  const receipt = await bridge.prompt({
    session: "builder",
    text: "make a file",
    cwd: workspace,
    record: path.join(workspace, "record.md"),
  });
  assert.match(receipt.sessionId, /^session-/);
});

test("a record naming this bridge's own state directory is refused, distinctly from the shape refusal above, and the state map is left untouched", async (t) => {
  // `stateFile` is a real absolute path this stand actually reads and writes, taken from the stand
  // itself rather than handed as a literal, so this exercises the guard against the artifact it
  // actually protects rather than a string that merely happens to look like it.
  const { bridge, workspace, stateFile, replays } = stand(t);
  // A first prompt so the state map holds real bytes this test can check are unmoved, rather than
  // asserting "still absent" against a file the refusal itself might never have created.
  await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace });
  await until(() => replays() >= 1, "the first, unrelated prompt's replay to end");
  const before = readFileSync(stateFile, "utf8");

  for (const target of [stateFile, path.join(path.dirname(stateFile), "sibling.md")]) {
    await assert.rejects(
      bridge.prompt({ session: "builder", text: "make a file", cwd: workspace, record: target }),
      /own state directory/,
      `${JSON.stringify(target)} must be refused as this bridge's own bookkeeping, not as an ordinary path shape`,
    );
  }
  assert.equal(readFileSync(stateFile, "utf8"), before, "the state map's bytes are unchanged by either refused attempt");
  assert.equal(replays(), 1, "no runtime ran for either refusal; the one replay is the first, unrelated prompt");
});

test("a session's remembered record survives a restart, with no record argument on the resuming prompt", async (t) => {
  // The persisted half of section 3: `SessionRecord.record` is what a caller names once rather than
  // again on the first prompt after a restart, and a bridge restart is a fresh `Bridge` over the same
  // state file, exactly as it is for the workspace and the DSH session id.
  const { bridge, pushed, workspace, stateFile, own } = stand(t);
  const recordFile = path.join(workspace, "record.md");

  const first = await bridge.prompt({ session: "builder", text: "make a file", cwd: workspace, record: recordFile });
  await until(() => pushed.length > 0, "the turn to end");
  await bridge.kill("builder");

  assert.equal(scopeOnDisk(stateFile, workspace).builder.record, recordFile, "the record path reached disk with the rest of the record");

  const successor = own(
    new Bridge({
      stateFile,
      scope: workspace,
      home: path.join(workspace, "home"),
      runtime: { command: process.execPath, args: [FAKE, RUN], env: process.env, requestTimeoutMs: PATIENCE_MS },
      provider: "fake-provider",
      model: "fake-model",
      push: () => undefined,
      log: () => undefined,
    }),
  );

  // No record given: the resuming prompt is answered by the same conversation, and the file still
  // names the record this session remembered before the restart.
  const resumed = await successor.prompt({ session: "builder", text: "what did you create", cwd: workspace });
  assert.equal(resumed.sessionId, first.sessionId, "the same conversation resumes");
  assert.equal(scopeOnDisk(stateFile, workspace).builder.record, recordFile, "and the record path is still the one it was given before the restart");
});
