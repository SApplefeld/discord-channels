// A stand-in for the DSH SDK runtime: the same newline-delimited JSON-RPC over stdio, answering
// `initialize`, `session/prompt` and `shutdown`, with a captured notification stream replayed as if
// a worker had produced it.
//
// It exists so the bridge's tests drive the real SDK client over a real child process without a
// model, a network, a port, or the operator's harness home. What it replays is a fixture captured
// from an actual run, so the shapes the bridge parses are the runtime's own rather than a hand-made
// idea of them; the flags below bend that stream into the endings a live run produces rarely and
// the bridge has to answer correctly every time.
//
// Nothing is written to stdout but protocol frames: stdout is the pipe.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { runDirectly } from "../broker/entrypoint.ts";

interface Frame {
  jsonrpc: "2.0";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * The value after `--name`, or undefined when the flag is absent or carries no value of its own.
 *
 * A flag written where a value belongs is not a value: `--reason --own-idle` means two flags to
 * whoever wrote it, and read as a value it names every turn's ending `--own-idle` while the idle it
 * asked for never arrives, which reaches the suite as the bridge getting a turn kind wrong.
 */
export function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * One frame off stdin, or undefined for a line this runtime cannot read as one.
 *
 * Stdin is the transport, and a runtime that throws on an unreadable line dies mid-turn: the bridge
 * sees a lost stream and the suite reads a defect in the bridge that is not there.
 */
export function readFrame(line: string): Frame | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Frame) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most recent frame's write, settled once the pipe has taken it.
 *
 * Pipe writes are asynchronous on Windows, so a `process.exit` right after a `write` can drop the
 * frame the write queued. A path that exits on purpose awaits this first; the pipe delivers writes
 * in order, so the last write settling means every earlier one has too.
 */
let lastWrite: Promise<void> = Promise.resolve();

function send(frame: Frame): void {
  lastWrite = new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`, () => resolve());
  });
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rewrite an inbox receipt to name the message this runtime just queued.
 *
 * The receipt is how a runtime says which queued message it is now running, and the capture names
 * the message of the run it came from. Replaying that id verbatim would confirm somebody else's
 * prompt, which is exactly what a client waiting on its own receipt refuses to accept.
 */
function withMessageId(event: { type?: string; data?: Record<string, unknown> }, messageId: string): Record<string, unknown> {
  const inserted = event.data?.inserted;
  if (!Array.isArray(inserted)) return event as Record<string, unknown>;
  return {
    ...event,
    data: { ...event.data, inserted: inserted.map((message) => ({ ...(message as Record<string, unknown>), id: messageId })) },
  };
}

/**
 * One assistant message with every text block's text replaced by `text`, or the message as it was
 * when it carries no content array to rewrite.
 */
function withAnswer(message: unknown, text: string): unknown {
  if (typeof message !== "object" || message === null) return message;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    content: content.map((block) => {
      const typed = block as { type?: unknown };
      return typed.type === "text" ? { ...typed, text } : block;
    }),
  };
}

/**
 * Replay one captured run against `sessionId`.
 *
 * The fixture's own session id is replaced rather than kept, because the id under test is the one
 * the bridge minted and remembered, and a stream carrying the capture's id would be a stream the
 * bridge correctly ignores as some other session's.
 */
async function replay(file: string, sessionId: string, messageId: string, argv: readonly string[], answer?: Frame): Promise<void> {
  const delayMs = Number(option(argv, "delay") ?? "0");
  const reason = option(argv, "reason");
  const stopBeforeIdle = argv.includes("--stop-before-idle");
  const files = Number(option(argv, "files") ?? "0");
  const answerChars = option(argv, "answer-chars");
  let flooded = false;
  let answered = false;
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");

  for (const line of lines) {
    const frame = JSON.parse(line) as { method: string; params: Record<string, unknown> };
    const params: Record<string, unknown> = { ...frame.params, sessionId };
    if (frame.method === "session.status" && params.status === "idle" && stopBeforeIdle) continue;
    if (frame.method === "session.event") {
      const event = params.event as { type?: string; data?: Record<string, unknown> };
      if (event.type === "agent/inbox/spliced") params.event = withMessageId(event, messageId);
      if (event.type === "turn/end" && reason !== undefined) {
        params.event = { ...event, data: { ...event.data, reason: { kind: reason } } };
      }
      // A worker whose answer runs to any length the test names. The bridge reads a turn's answer
      // off the text blocks of its assistant messages, so those are what carry the long text, and a
      // message that is only a tool call is left as the capture has it: what changes is the surface
      // the bridge reads, and nothing beside it.
      if (event.type === "assistant/message" && answerChars !== undefined) {
        params.event = { ...event, data: { ...event.data, message: withAnswer(event.data?.message, "a".repeat(Number(answerChars))) } };
      }
    }
    notify(frame.method, params);
    // Emitted here rather than beside the handshake, because a bridge subscribes after its start
    // call resolves: a notification written before that reaches a client with no subscriptions and
    // is dropped, so a test asserting that the bridge ignored it would be asserting about a frame
    // the bridge never saw. The receipt is the point where the bridge has subscribed, registered a
    // turn, and confirmed that turn as its own.
    //
    // The two flags differ only in which session the idle names, which is what the bridge routes
    // on: `--own-idle` is the control for `--foreign-idle` and ends the turn where it stands.
    if (frame.method === "session.event" && (params.event as { type?: string }).type === "agent/inbox/spliced") {
      // The runtime answering the prompt request only once it has spliced the message, with the
      // rest of the turn held back until the test says so. The answer goes out on its own I/O event,
      // a pause after the receipt, so the bridge has read the receipt before the answer arrives,
      // and the turn's remaining events wait for the go-file, which the test writes once the prompt
      // call has returned: the bridge's own answer to the request has then run against a receipt it
      // has seen and an idle it has not, which is the ordering this flag exists to produce.
      if (answer !== undefined && !answered) {
        answered = true;
        await sleep(50);
        send(answer);
        const goFile = option(argv, "go-file");
        if (goFile !== undefined) {
          while (!existsSync(goFile)) await sleep(10);
        }
      }
      // The runtime dying with the turn half done, at the one point where the bridge has confirmed
      // the turn as its own: what follows is a lost stream with a turn in flight behind it. Once
      // per test rather than once per process, because the runtime the bridge spawns next is a new
      // process with no memory of this one, and the test needs that one to run its turn to the end;
      // the marker sits beside the done-file, which is the one path every runtime under a test shares.
      if (argv.includes("--die-after-receipt")) {
        const doneFile = option(argv, "done-file");
        const lostMarker = doneFile === undefined ? undefined : `${doneFile}.lost`;
        if (lostMarker === undefined || !existsSync(lostMarker)) {
          if (lostMarker !== undefined) appendFileSync(lostMarker, "lost\n");
          // The answer and the receipt are on the pipe before the process goes, so what the bridge
          // sees is a runtime that took the prompt and then died, never one whose answer was lost.
          await lastWrite;
          process.exit(1);
        }
      }
      if (argv.includes("--foreign-idle")) notify("session.status", { sessionId: "session-foreign", status: "idle" });
      if (argv.includes("--own-idle")) notify("session.status", { sessionId, status: "idle" });
      // The runtime's own number for the turn it is starting, which the bridge takes over its stored
      // count. Named by the test so the number can sit behind the count as well as ahead of it.
      const turnStart = option(argv, "turn-start");
      if (turnStart !== undefined) notify("session.event", { sessionId, event: { type: "turn/start", data: { turn: Number(turnStart) } } });
      // One write to a path the receipt cannot spell relative to the workspace: another drive, or
      // on Windows a root with no drive. Written once per replay, at the first receipt.
      const foreignFile = option(argv, "foreign-file");
      if (foreignFile !== undefined && !flooded) {
        notify("session.event", {
          sessionId,
          event: { type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: foreignFile }) } },
        });
      }
      // A worker looping over a tree, which is the ordinary shape of a turn that touches more files
      // than any receipt can name. Written once per replay, at the first receipt, because the
      // capture carries two of them.
      if (!flooded) {
        flooded = true;
        for (let index = 0; index < files; index += 1) {
          notify("session.event", {
            sessionId,
            event: { type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: `looped-${String(index)}.txt` }) } },
          });
        }
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  // An idle for a session that has already gone idle. A bridge that pushed on every idle rather
  // than on every turn would send the operator the same answer twice.
  if (argv.includes("--extra-idle")) notify("session.status", { sessionId, status: "idle" });

  // The end of the stream, announced where a test can wait on it. A replay that ends without an
  // idle status ends with no signal of its own, and a test that waited for the stream to look
  // quiet instead would be timing the machine rather than the runtime.
  const doneFile = option(argv, "done-file");
  if (doneFile !== undefined) appendFileSync(doneFile, "replay-end\n");
}

function start(argv: readonly string[]): void {
  const fixture = argv[2];
  if (fixture === undefined) {
    process.stderr.write("fake-dsh: no fixture path given\n");
    process.exit(2);
  }
  // Where this runtime says it was spawned at all, one line per process, appended before a frame is
  // read. A test asserting that a refusal spent no spawn needs the runtime's own word for it: the
  // bridge's `busy()` is empty after a refusal whether or not a child was started for it.
  const spawnFile = option(argv, "spawn-file");
  if (spawnFile !== undefined) appendFileSync(spawnFile, "spawned\n");

  let buffer = "";
  /** How many prompts this runtime has taken, so two of them never share a message id. */
  let prompts = 0;
  /** Prompt answers held back until the shutdown, under `--answer-at-shutdown`. */
  const pendingAnswers: Frame[] = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      const frame = readFrame(line);
      if (frame?.id === undefined) continue;
      if (frame.method === "initialize") {
        send({ jsonrpc: "2.0", id: frame.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "fake" } } });
        continue;
      }
      if (frame.method === "session/prompt") {
        const sessionId = String(frame.params?.sessionId ?? "");
        const messageId = `message-${String(Date.now())}-${String(prompts)}`;
        prompts += 1;
        // A runtime that takes the prompt and never answers for it. The SDK bounds the request and
        // the runtime keeps running the turn, which is the one case where the bridge has a turn in
        // flight whose queued message id it will never learn.
        if (argv.includes("--swallow-prompt")) continue;
        // The same, for the first prompt alone, so a second session can run to its end beside a
        // first whose turn is in flight and unaccepted.
        if (argv.includes("--swallow-first-prompt") && prompts === 1) continue;
        // A runtime that dies under the second prompt request, answering nothing: the request fails
        // on a closed transport, and whether the bridge learns of the death from that failure or
        // from the stream's end first is the scheduler's to pick.
        if (argv.includes("--die-on-second-prompt") && prompts === 2) process.exit(1);
        // A runtime that answers the prompt only as it shuts down, which is the ordering where a
        // kill has already reported the turn and the answer to the request arrives all the same.
        if (argv.includes("--answer-at-shutdown")) {
          pendingAnswers.push({ jsonrpc: "2.0", id: frame.id, result: { messageId } });
          continue;
        }
        // A runtime that answers the prompt with an ordinary JSON-RPC error, which is what a
        // session it will not run looks like on this wire. The turn never starts, and the runtime
        // is alive and bound to the workspace it was initialized in.
        if (argv.includes("--refuse-prompt") || (argv.includes("--refuse-second-prompt") && prompts === 2)) {
          send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "the runtime refused this prompt" } });
          continue;
        }
        const answer = { jsonrpc: "2.0", id: frame.id, result: { messageId } } as const;
        // A message queued ahead of this prompt in the same session, spliced and run to its idle
        // before this prompt's own receipt: the shape a session that was already working produces.
        // The idle names this session, since it is this session's turn that ended, and the message
        // id is one this prompt was never answered with.
        if (argv.includes("--queued-ahead")) {
          notify("session.event", {
            sessionId,
            event: { type: "agent/inbox/spliced", data: { target: "next-turn", inserted: [{ id: "message-queued-ahead", role: "user" }] } },
          });
          notify("session.status", { sessionId, status: "idle" });
        }
        // The answer to the request goes out from inside the replay, once the receipt has: the
        // ordering in which the bridge learns its message id between the splice and the idle.
        if (argv.includes("--answer-after-receipt")) {
          void replay(fixture, sessionId, messageId, argv, answer).catch((error: unknown) => {
            process.stderr.write(`fake-dsh: replay failed: ${String(error)}\n`);
          });
          continue;
        }
        // A whole turn that arrives, ending and all, before the response to the prompt that started
        // it. The wire allows it and a busy runtime produces it, and it is the window where the
        // bridge ends a turn from inside its own prompt call.
        if (argv.includes("--end-before-response")) {
          void replay(fixture, sessionId, messageId, argv)
            .catch((error: unknown) => {
              process.stderr.write(`fake-dsh: replay failed: ${String(error)}\n`);
            })
            // Held before answering, because the client delivers notifications through an async
            // iterator and the request's own answer through a promise: written back to back they
            // reach the bridge in whichever order the scheduler picks, and this flag exists to
            // produce one of those orders rather than a coin toss.
            .then(() => sleep(50))
            .finally(() => {
              send(answer);
            });
          continue;
        }
        send(answer);
        // Activity the session was already carrying on when the prompt arrived, which a resumed
        // session replaying its loaded state produces and so does a turn queued ahead of this one.
        // It precedes this prompt's receipt, so none of it is this turn's work, and a bridge that
        // recorded it would answer the model with somebody else's text over somebody else's count
        // of files and commands.
        if (argv.includes("--before-receipt")) {
          notify("session.event", { sessionId, event: { type: "turn/start", data: { turn: 41 } } });
          notify("session.event", {
            sessionId,
            event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "someone else's turn" }] } } },
          });
          notify("session.event", {
            sessionId,
            event: { type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: "not-this-turn.txt" }) } },
          });
          notify("session.event", { sessionId, event: { type: "tool/call", data: { name: "pwsh", arguments: "{}" } } });
        }
        // An idle for work the session was doing when the prompt arrived: a resumed session
        // reporting its loaded state, or a turn queued ahead of this one. It precedes this prompt's
        // own receipt, so it is not this turn's end and a bridge that treated it as one would
        // answer the model with an empty turn and drop the real answer when it came.
        if (argv.includes("--idle-before-receipt")) notify("session.status", { sessionId, status: "idle" });
        void replay(fixture, sessionId, messageId, argv).catch((error: unknown) => {
          process.stderr.write(`fake-dsh: replay failed: ${String(error)}\n`);
        });
        continue;
      }
      if (frame.method === "shutdown") {
        // Ahead of the shutdown's own answer and on the same pipe, which is the wire ordering where
        // a prompt request is answered after the kill that ended its turn.
        for (const held of pendingAnswers.splice(0)) send(held);
        send({ jsonrpc: "2.0", id: frame.id, result: {} });
        setTimeout(() => process.exit(0), 10);
        continue;
      }
      send({ jsonrpc: "2.0", id: frame.id, result: {} });
    }
  });
  // The client's teardown closes stdin first and escalates only if the child stays. Exiting here is
  // what makes the cooperative rung work, so a kill does not spend the SIGTERM grace every time.
  process.stdin.on("end", () => process.exit(0));
}

if (runDirectly(import.meta.url)) {
  start(process.argv);
}
