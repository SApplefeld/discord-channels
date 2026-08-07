// The HTTP intake. This listener is the project's main attack surface: anything that can post here
// can eventually put text in front of Claude, so every field arriving over it is untrusted data and
// is never treated as an instruction, interpolated, or executed.
//
// The wire shape, which the Section 3 hooks are written against:
//
//   POST /hook
//     X-Channel-Hook-Event:     SessionStart | PostToolUse | Stop
//     X-Channel-Process-Token:  the CHANNEL_PROCESS_TOKEN GUID the launch wrapper minted
//     X-Channel-Session-Name:   the CHANNEL_SESSION human name (optional)
//     Content-Type:             application/json
//     body: the hook payload verbatim, exactly as Claude Code emits it, kept only as far as the
//     fields the registry stores, one of which is a bounded preview of the tool's input, so this
//     route carries a little session content and not none; a body past maxBodyBytes is drained and
//     dropped with a 202, because the Stop payload carries the turn's final assistant message and a
//     refusal there is a visible error inside the session at the end of its longest turns.
//
// The event name rides in a header rather than the body because two of the three hooks are `http`
// hooks, whose body is authored by Claude Code and cannot be wrapped. A header is static per hook
// declaration, so each declaration names its own event, and the SessionStart `command` hook posts
// its stdin with the same three headers. One shape for all three transports.
//
//   POST /mirror
//     the same three headers, with X-Channel-Hook-Event naming UserPromptSubmit or Stop, carrying
//     a console prompt or a turn's final assistant reply in the hook payload, plus one more:
//     X-Channel-Mirror, present only when the launching session set CHANNEL_SESSION_MIRROR
//     (wrapper's -NoMirror does), carrying that session's own escape from the host-wide mirror
//     switch. This is the one content-bearing route: a token-authenticated post has its prompt or
//     last_assistant_message extracted and handed to the routing layer for the session's bound
//     thread, and every drop path (no token, unknown token, mirroring off host-wide or for this
//     session, body over its own ceiling, field absent) answers 202, because the installed hooks
//     post here from every session on the machine and a non-2xx is a visible error inside that
//     session. The content itself never appears in the broker log at any level; see handleMirror.
//
//   GET /sessions  -> the registry as JSON, for debugging.
import type { IncomingMessage, ServerResponse } from "node:http";
import { FLAG_FALSE } from "./config.ts";
import type { Logger } from "./log.ts";
import type { HookEvent, HookIntake, Registry, SessionRecord } from "./registry.ts";
import type { MirrorKind } from "./routing/outbound.ts";
import { clean } from "./sanitize.ts";

const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "PostToolUse", "Stop"];

/**
 * The mirror route's own event vocabulary, mapped to what each payload's text means. Deliberately
 * not HOOK_EVENTS and not the HookEvent type: those belong to the liveness path, no liveness hook
 * sends UserPromptSubmit, and widening either would let a mirror post masquerade as a liveness
 * event or the reverse.
 */
const MIRROR_EVENTS: Readonly<Record<string, { kind: MirrorKind; field: string }>> = {
  UserPromptSubmit: { kind: "prompt", field: "prompt" },
  Stop: { kind: "reply", field: "last_assistant_message" },
};

/** The only names this listener answers to. A port suffix is allowed on any of them. */
const ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * True only for an address on the IPv4 loopback block, the IPv6 loopback, or an IPv4-mapped IPv6
 * form of either. An absent address fails closed: a request the socket cannot attribute is not one
 * to trust.
 *
 * Binding to 127.0.0.1 already makes an off-box connection impossible, so this is defense in depth
 * against a future bind change or a proxy placed in front of the port.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;

  let address = remoteAddress.trim().toLowerCase();
  if (address === "") return false;

  // Node reports a link-local scope as ::1%lo0 and IPv4-mapped addresses as ::ffff:127.0.0.1.
  const scope = address.indexOf("%");
  if (scope !== -1) address = address.slice(0, scope);
  if (address === "::1") return true;
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);

  const octets = address.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  return octets[0] === "127";
}

/**
 * True only when the request addressed this listener by a loopback name.
 *
 * `isLoopback` cannot cover this on its own. In a DNS rebinding attack the browser genuinely
 * connects to 127.0.0.1, so the socket peer is honest; what identifies the attack is that the page
 * asked for `http://attacker.example:PORT/`, which is also what makes the browser treat this
 * listener as same-origin and skip the preflight. The Host header is the only place that name
 * survives, so it is checked here.
 *
 * A missing, array-valued, or unparseable Host fails closed. The port suffix is accepted but not
 * compared against the listening port: a page can only reach a port it connected to, so the port
 * carries no signal, while the hostname does.
 */
export function isAllowedHost(hostHeader: string | string[] | undefined): boolean {
  // Node keeps one Host header, but a rewriting proxy could present several, and a set of names
  // is not a name.
  if (typeof hostHeader !== "string") return false;

  const host = hostHeader.trim().toLowerCase();
  if (host === "") return false;

  // Split the port off, taking care not to cut an unbracketed IPv6 literal in half.
  const separator = host.lastIndexOf(":");
  const bracketed = host.endsWith("]");
  let name = host;
  if (!bracketed && separator !== -1) {
    const port = host.slice(separator + 1);
    if (!/^\d{1,5}$/.test(port)) return false;
    name = host.slice(0, separator);
  }

  return ALLOWED_HOSTS.includes(name);
}

/** How long a suppressed run of the same refusal reason is aggregated before its next flush. */
const REFUSAL_WINDOW_MS = 60_000;

/** Truncates a value logged verbatim from the wire, so a header cannot pad a log line without limit. */
function capped(value: string, limit = 200): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

type RefusalLog = { warn: (reason: string, detail: string) => void };

/**
 * Rate-limits refusal logging by reason, so a local process cannot flood the log with its own
 * refused requests to push earlier evidence of the same behavior out through rotation. The first
 * refusal of a given reason is logged immediately; a repeat within the window is counted instead
 * of logged, and the count is flushed as one summary line the next time that reason's window has
 * closed. No timer: the flush is lazy, on the next call, which keeps this free of anything to
 * clear on shutdown and keeps it drivable by an injected clock in a test.
 */
function createRefusalLog(log: Logger | undefined, now: () => number): RefusalLog {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return {
    warn(reason, detail) {
      if (!log) return;
      const at = now();
      const entry = state.get(reason);
      if (entry !== undefined && at - entry.windowStart < REFUSAL_WINDOW_MS) {
        entry.suppressed += 1;
        return;
      }
      if (entry !== undefined && entry.suppressed > 0) {
        log.warn(
          `hook refused: ${reason} occurred ${entry.suppressed} more time(s) in the last ` +
            `${REFUSAL_WINDOW_MS}ms`,
        );
      }
      log.warn(`hook refused: ${reason} (${detail})`);
      state.set(reason, { windowStart: at, suppressed: 0 });
    },
  };
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const cleaned = clean(raw);
  return cleaned === "" ? null : cleaned;
}

/** Reads a payload string field, tolerating absence and rejecting anything that is not a string. */
function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const cleaned = clean(value);
  return cleaned === "" ? null : cleaned;
}

/**
 * The tool-input fields a preview is taken from, in the order they are tried.
 *
 * An ordered probe rather than a table keyed by tool name, so an MCP tool and a tool Claude Code
 * adds later still get a useful preview instead of nothing, and so there is no per-tool table to
 * keep in step with a harness this project does not control. The order runs from what identifies a
 * call most precisely to what identifies it least: a shell command before a path, a path before a
 * free-text description.
 */
const TOOL_INPUT_PREVIEW_KEYS: readonly string[] = [
  "command",
  "file_path",
  "pattern",
  "url",
  "path",
  "description",
  "query",
  "prompt",
];

/**
 * The first previewable field of a tool's input, cleaned like every other payload string.
 *
 * A `tool_input` that is absent, not a JSON object, or carries none of those keys previews nothing,
 * and so does one whose value is not a string: the read goes through `payloadString`, whose type
 * check is what keeps a nested object or an array out, prototype keys included. A field that is
 * empty once cleaned is not a preview either, so the probe goes on to the next key rather than
 * reporting a blank one.
 *
 * `tool_response` has no probe of its own and is dropped: it is unbounded, arrives after the work
 * it describes is already done, and says nothing the card's own state does not.
 */
function toolInputPreview(payload: Record<string, unknown>): string | null {
  const input = payload["tool_input"];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_PREVIEW_KEYS) {
    const value = payloadString(fields, key);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Longest transcript path accepted. Well past the longest real one observed on this machine (206
 * characters) and past the classic Windows MAX_PATH, so a deep checkout still fits; what it
 * bounds is storage, not legitimate traffic.
 */
const MAX_TRANSCRIPT_PATH_LENGTH = 1024;

// C0 and DEL, the same class clean() strips; local because clean() also caps at MAX_FIELD_LENGTH,
// which is exactly what a path must not have done to it (see transcriptPathField).
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The transcript path, read under its own rules because it is an instruction to open a file, not
 * a display string. Control characters are stripped and the result trimmed, as clean() does, but
 * every other deviation is refused whole rather than normalized: a path cut at a cap would never
 * open and would leave only a rate-limited pass-failed line forever, indistinguishable from a
 * genuinely unreadable file, and a UNC path opened on Windows initiates an outbound SMB
 * connection carrying the operator's credentials. Refused means the tailer never learns a path
 * for that session, which is a legible failure. Accepted shapes are exactly what the hooks send:
 * an absolute local path, drive-letter or POSIX.
 */
function transcriptPathField(payload: Record<string, unknown>): string | null {
  const value = payload["transcript_path"];
  if (typeof value !== "string") return null;
  const path = value.replace(PATH_CONTROL_CHARACTERS, "").trim();
  if (path === "" || path.length > MAX_TRANSCRIPT_PATH_LENGTH) return null;
  // Both slash spellings: Windows opens //host/share and \\host\share alike, and \\?\ and \\.\
  // prefixed paths begin the same way.
  if (path.startsWith("\\\\") || path.startsWith("//")) return null;
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("/")) return null;
  return path;
}

export type IntakeFailure = { status: number; message: string };

export function parseIntake(
  request: IncomingMessage,
  body: string,
): { intake: HookIntake } | { failure: IntakeFailure } | { unwatched: true } {
  const event = header(request, "x-channel-hook-event");
  if (event === null || !HOOK_EVENTS.includes(event as HookEvent)) {
    return { failure: { status: 400, message: "unknown or missing X-Channel-Hook-Event" } };
  }

  const processToken = header(request, "x-channel-process-token");
  if (processToken === null) {
    // The installed hooks fire in every session on the machine, and a session started without the
    // launch wrapper carries no process token. That is unwatched traffic, not malformed traffic:
    // it is dropped rather than refused, because Claude Code surfaces a non-2xx hook response as a
    // visible error after every tool call inside that session.
    return { unwatched: true };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { failure: { status: 400, message: "body is not valid JSON" } };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { failure: { status: 400, message: "body is not a JSON object" } };
  }
  const fields = payload as Record<string, unknown>;

  const sessionId = payloadString(fields, "session_id");
  if (event === "SessionStart" && sessionId === null) {
    return { failure: { status: 400, message: "SessionStart payload has no session_id" } };
  }

  return {
    intake: {
      event: event as HookEvent,
      processToken,
      sessionName: header(request, "x-channel-session-name"),
      sessionId,
      // Recorded verbatim rather than checked against the known trigger names, so a value Claude
      // Code adds later lands in the registry instead of being refused.
      source: payloadString(fields, "source"),
      toolName: payloadString(fields, "tool_name"),
      // One bounded field of tool_input is kept, for the card's `Last tool:` line; the rest of it,
      // and the whole of tool_response, are dropped as unbounded and of no use to any surface the
      // broker renders.
      toolInput: toolInputPreview(fields),
      // Through its own reader rather than payloadString: a path is opened, not displayed, so a
      // malformed one is refused whole instead of normalized into a different path (see
      // transcriptPathField). It is used only as an argument to a read: the tailer holds it in
      // memory and nothing persists or publishes it.
      transcriptPath: transcriptPathField(fields),
    },
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * How far past a route's ceiling the drain keeps consuming before the connection is destroyed.
 * The drain exists so an honestly-oversized post still gets its quiet 2xx, but an unbounded drain
 * would let a local process stream an endless chunked body and hold the connection and this loop
 * forever. Past this multiple the sender is not an installed hook, and it loses the quiet answer
 * along with the socket.
 */
const DRAIN_LIMIT_FACTOR = 4;

/**
 * Reads a body up to the calling route's ceiling. Past the ceiling, what was buffered is released
 * and the rest of the stream is consumed and discarded, so an oversized post costs at most the
 * ceiling in memory while still leaving the connection drained and usable under keep-alive; past
 * the drain limit the connection is destroyed instead. Only the byte count comes back on the
 * over-ceiling paths: the caller logs the count, never the text.
 *
 * Both routes read through this one function. Their ceilings differ, and nothing else about the
 * read does: a post over either one is a post from an installed hook that fires in every session on
 * the machine, and refusing one puts a visible error inside that session at the end of exactly its
 * longest turns.
 */
async function readCappedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ body: string } | { droppedBytes: number; destroyed: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      if (!over) {
        over = true;
        chunks.length = 0;
      }
      if (size > maxBytes * DRAIN_LIMIT_FACTOR) {
        request.destroy();
        return { droppedBytes: size, destroyed: true };
      }
      continue;
    }
    chunks.push(buffer);
  }
  if (over) return { droppedBytes: size, destroyed: false };
  return { body: Buffer.concat(chunks).toString("utf8") };
}

export type HandlerOptions = {
  registry: Registry;
  maxBodyBytes: number;
  /**
   * Where a refused, malformed, or silently-dropped hook post becomes visible. Optional so every
   * existing caller and test that does not pass one keeps working; a request is still served with
   * no logger at all, just with nothing written down about it.
   */
  log?: Logger;
  /** Drives the refusal-log rate limiter. Injected so a test can move the window without sleeping. */
  now?: () => number;
  /**
   * The transcript tailer's two seams. Optional because the tailer exists only while interim
   * mirroring is on: with no seam wired, no path is ever learned and no transcript is ever
   * opened, so "off" is the absence of the machinery rather than a check inside it.
   */
  tail?: {
    /** Teaches the tailer where a credited session's transcript lives. */
    learn: (sessionId: string, path: string) => void;
    /**
     * Reports a live session's mirror-on verdict. The tailer fails closed, so the affirmative
     * signal is load-bearing: without one, a learned path is never read.
     */
    allow: (sessionId: string) => void;
    /** Stops a session's transcript being read, on the session's own mirror-off switch. */
    suppress: (sessionId: string) => void;
  };
  /**
   * The mirror route's knobs and its seam into the routing layer. Required rather than optional,
   * so a caller cannot wire the handler and silently leave the mirror unrouted: a mirror hook
   * posting into a route that drops everything looks identical to a session nobody typed in.
   */
  mirror: {
    /** Off, every mirror post is accepted, drained, and dropped; nothing is delivered. */
    enabled: boolean;
    /** The mirror route's own body ceiling. maxBodyBytes above keeps governing /hook alone. */
    maxBytes: number;
    /**
     * Hands one authenticated prompt or reply to the routing layer, with the session the payload
     * names (null when it names none) so the router can drop a straggler from a replaced session.
     * The returned promise is observed only to contain a rejection; the response is already
     * written when it settles, so the hook never waits on Discord.
     */
    deliver: (
      processToken: string,
      kind: MirrorKind,
      text: string,
      sessionId: string | null,
    ) => Promise<unknown>;
  };
};

/**
 * What `GET /sessions` publishes. The process token is withheld: it is the join key a hook post is
 * authenticated by, so anything that can read one can forge session traffic.
 */
export type PublicSessionRecord = Omit<SessionRecord, "processToken">;

export function redact(record: SessionRecord): PublicSessionRecord {
  // Field by field rather than by deleting from a copy, so a field added to SessionRecord has to
  // be published deliberately instead of arriving here on its own.
  return {
    sessionId: record.sessionId,
    name: record.name,
    host: record.host,
    source: record.source,
    state: record.state,
    lastTool: record.lastTool,
    lastToolInput: record.lastToolInput,
    toolCount: record.toolCount,
    turnCount: record.turnCount,
    startedAt: record.startedAt,
    lastHookAt: record.lastHookAt,
    lastRelayAt: record.lastRelayAt,
    endedAt: record.endedAt,
  };
}

export function createHandler(
  options: HandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const refusals = createRefusalLog(options.log, options.now ?? Date.now);

  // The content-bearing intake. This function is the one place broker code holds mirror content,
  // and the invariant every branch of it upholds is that the content never appears in the broker
  // log at any level: not in a refusal line, not in an error path, not truncated, not as a byte
  // preview. Every log call here carries a static message or a byte count, and every caught error
  // object is discarded unread, because a thrown error can quote the text that produced it.
  async function handleMirror(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // An event outside the mirror's own vocabulary is refused with the same 400 the /hook route
    // gives the same class of malformed post. The installed mirror hooks carry one of these two
    // values as a static header, so whatever sent this is not a hook and the 400 cannot surface
    // as an in-session error. The logged detail is static; nothing captured from the wire rides
    // in it.
    //
    // Object.hasOwn, never a bare index: MIRROR_EVENTS is a plain object, and a bare lookup
    // answers prototype keys, so a header naming "constructor" or "__proto__" would skip this 400
    // and run the authenticated path with an undefined mapping.
    const event = header(request, "x-channel-hook-event");
    const mapping =
      event !== null && Object.hasOwn(MIRROR_EVENTS, event) ? MIRROR_EVENTS[event] : undefined;
    if (mapping === undefined) {
      request.resume();
      refusals.warn("mirror event rejected", "unknown or missing X-Channel-Hook-Event");
      send(response, 400, { error: "unknown or missing X-Channel-Hook-Event" });
      return;
    }

    // Off means accepted, drained, and dropped: the hooks are installed machine-wide and keep
    // posting whether or not the operator wants content mirrored, so the off switch has to be
    // quiet at the socket rather than refusing anything.
    if (!options.mirror.enabled) {
      request.resume();
      send(response, 202, { ignored: true });
      return;
    }

    // The token header is checked before any of the body is read. An unwrapped session on this
    // machine posts its full prompt and reply here on every turn, and that content must transit
    // the socket and be discarded unread, never assembled into a string in broker memory. Nothing
    // is logged: tokenless mirror traffic is the steady state of every unwrapped session, not a
    // fault, and a per-prompt log line would say nothing but that someone is using the machine.
    const processToken = header(request, "x-channel-process-token");
    if (processToken === null) {
      request.resume();
      send(response, 202, { ignored: true });
      return;
    }

    // A token no live session holds, also decided before the body is read. Accepted off the wire
    // and dropped, exactly as /hook drops the same traffic, so a replayed or forged post learns
    // nothing from the response. The process token itself is never logged; it is the forgery key,
    // and this is exactly the traffic a forged one would produce.
    const holder = options.registry.current(processToken);
    if (holder === null) {
      request.resume();
      refusals.warn("mirror post dropped", "no live session holds this process token");
      send(response, 202, { ignored: true });
      return;
    }

    // The per-session escape: wrapper/Enter-ClaudeSession.ps1's -NoMirror sets
    // CHANNEL_SESSION_MIRROR in the launched session's own environment, and the mirror hooks
    // forward it as this header. Checked here, after the token has identified a live session,
    // rather than alongside the anonymous checks above: it is a property of a known session, not
    // of an arbitrary request, and checking it earlier would let an off header on a forged or
    // unrecognized token take the same quiet 202 path as a legitimate suppression, swallowing the
    // "no live session holds this process token" line above, which is the only record of that
    // traffic.
    //
    // The off vocabulary is FLAG_FALSE, imported from broker/config.ts rather than re-listed here,
    // so the header and the config knob read one shared spelling of "off" rather than two that
    // could drift. The read is deliberately permissive where the config knob's strictFlag is not:
    // CHANNEL_MIRROR the env var refuses an unrecognized spelling at broker startup, where a thrown
    // error is the operator's to see and fix before anything runs. This header arrives per request
    // from a session's own environment, and the only way to refuse a request is a non-2xx response,
    // which Claude Code surfaces as a visible error inside that session on every prompt and every
    // turn end. So an absent header (every session that never set CHANNEL_SESSION_MIRROR, the
    // overwhelming majority) and an unrecognized spelling both fall through to mirroring normally;
    // only a value in FLAG_FALSE turns this one post off.
    const sessionMirror = header(request, "x-channel-mirror");
    if (sessionMirror !== null && FLAG_FALSE.includes(sessionMirror.toLowerCase())) {
      request.resume();
      // The same switch covers the transcript tailer: a session that opted out of having its
      // content mirrored must not have its mid-turn transcript text published either, and the
      // header only ever arrives on this route. UserPromptSubmit fires at the start of every
      // turn, so the suppression is recorded before that turn can produce any interim text.
      options.tail?.suppress(holder.sessionId);
      // Static and session-identifying only, never content and never the token: without this line,
      // a session the operator suppressed and a mirror that is silently broken both read as total
      // silence in the log, with no way to tell which is happening.
      refusals.warn("mirror post suppressed by session switch", `session=${holder.sessionId}`);
      send(response, 202, { ignored: true });
      return;
    }

    const read = await readCappedBody(request, options.mirror.maxBytes);
    if ("droppedBytes" in read) {
      if (read.destroyed) {
        // The connection is already gone, so there is no response to write; the log line is the
        // only witness. The count is logged; the text is not.
        refusals.warn(
          "mirror drain cut off",
          `${read.droppedBytes} bytes in; the connection was destroyed`,
        );
        return;
      }
      // Drained and dropped with a 202, never a 413: a 413 is a visible error inside the session
      // at the end of exactly the longest turns. Up to the ceiling was buffered and released; only
      // the excess was never buffered. The count is logged; the text is not.
      refusals.warn(
        "mirror post over the size cap",
        `${read.droppedBytes} bytes dropped unposted`,
      );
      send(response, 202, { ignored: true });
      return;
    }

    // Each refusal cause carries its own rate-limiter reason key: the limiter suppresses by
    // reason, so a shared key would let one cause's burst mask the other causes' first
    // occurrences for the length of the window.
    let payload: unknown;
    try {
      payload = JSON.parse(read.body);
    } catch {
      // The parse error is discarded, not logged or echoed: V8 embeds an excerpt of the source
      // text in its message, and here the source text is mirror content. The 400 matches /hook's
      // answer for the same malformation, which no installed hook produces.
      refusals.warn("mirror body not JSON", "the body does not parse; its text is not logged");
      send(response, 400, { error: "body is not valid JSON" });
      return;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      refusals.warn("mirror body not an object", "the body is JSON but not an object");
      send(response, 400, { error: "body is not a JSON object" });
      return;
    }
    const fields = payload as Record<string, unknown>;

    // The session the payload says it belongs to, forwarded so the router can drop a straggler
    // from a session that a /clear has since replaced under the same process token. An identity
    // field, so payloadString's cap is correct here.
    const sessionId = payloadString(fields, "session_id");

    // The affirmative half of the mirror verdict, and the tailer's whole permission to read. The
    // tailer fails closed, so a normal session is re-allowed at the first UserPromptSubmit of every
    // turn while a -NoMirror session, which only ever reaches the off branch above, is never read.
    //
    // The two halves are deliberately asymmetric about what evidence they need. Suppression is
    // recorded on the token alone, before the body is read, because failing closed on weak evidence
    // costs at most some narration. Permission requires the payload to name the very session the
    // token holds, which is the same straggler gate routing/outbound.ts applies before it posts:
    // every process a wrapped session spawns inherits the token, so a post that names another
    // session, or names none, is not this session speaking and is not its verdict to give.
    if (sessionId !== null && sessionId === holder.sessionId) options.tail?.allow(holder.sessionId);

    // Extracted raw rather than through payloadString: clean() caps at MAX_FIELD_LENGTH, and a
    // mirrored reply is exactly the string that must survive whole. Rendering safety belongs to
    // the posting side, which neutralizes the text at the Discord boundary. An absent or empty
    // field is a real case, not an error: a turn can end with an empty final message.
    const value = fields[mapping.field];
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      send(response, 202, { ignored: true });
      return;
    }

    // Answered before delivery, so the session's hook never waits on Discord: the mirror hook's
    // timeout is small, and a slow post charged against it would surface inside the session on
    // every prompt. The body is byte-identical to every drop's answer, so the response carries no
    // token-validity oracle; what remains is the timing difference the token-before-body ordering
    // buys, and that trade is deliberate, because the ordering is what keeps an unwrapped
    // session's content out of broker memory. A delivery failure is the routing layer's to
    // report; the rejection observed here is recorded without its detail, which can quote the
    // text it failed to post.
    send(response, 202, { ignored: true });
    void options.mirror.deliver(processToken, mapping.kind, text, sessionId).catch(() => {
      refusals.warn("mirror delivery failed", "the error detail is withheld; it can carry content");
    });
  }

  return (request, response) => {
    // Both checks run before the body is read, so a refused request cannot reach the registry.
    if (!isLoopback(request.socket.remoteAddress)) {
      refusals.warn("non-loopback remote address", `remote=${capped(request.socket.remoteAddress ?? "none")}`);
      send(response, 403, { error: "loopback only" });
      return;
    }

    // Closes DNS rebinding, where the socket peer is loopback but the page that opened it is not.
    if (!isAllowedHost(request.headers.host)) {
      refusals.warn("unrecognized Host header", `host=${capped(String(request.headers.host ?? "none"))}`);
      send(response, 403, { error: "unrecognized host" });
      return;
    }

    // A second, quieter defense against a cross-site POST: X-Channel-Hook-Event is not a CORS
    // simple header, so a browser must preflight to send it, and this server answers no OPTIONS
    // request. Adding an OPTIONS handler, or moving the event name into the body, removes that
    // property silently. The Host check above is what this rests on; keep both.
    const route = (request.url ?? "/").split("?")[0];

    if (request.method === "GET" && route === "/sessions") {
      send(response, 200, { sessions: options.registry.list().map(redact) });
      return;
    }

    if (request.method === "POST" && route === "/mirror") {
      void handleMirror(request, response).catch(() => {
        // The error is discarded, never stringified into a log line: a throw out of the mirror
        // path can quote the body text that produced it. A rate-limited refusal line records that
        // it happened, and the 202 keeps even a broken mirror path invisible inside the session.
        refusals.warn("mirror intake failed", "the error detail is withheld; it can carry content");
        if (!response.headersSent) send(response, 202, { ignored: true });
      });
      return;
    }

    if (request.method !== "POST" || route !== "/hook") {
      send(response, 404, { error: "not found" });
      return;
    }

    void (async () => {
      const read = await readCappedBody(request, options.maxBodyBytes);
      if ("droppedBytes" in read) {
        if (read.destroyed) {
          // The connection is already gone, so there is no response to write; the log line is the
          // only witness. The count is logged; the body is not.
          refusals.warn(
            "hook drain cut off",
            `${read.droppedBytes} bytes in; the connection was destroyed`,
          );
          return;
        }
        // Drained and dropped with a 202, never a 413. The Stop payload carries the turn's final
        // assistant message, so the longest turns are the ones that push a liveness post past this
        // ceiling, and a refusal there is a visible error inside the session at the end of exactly
        // those turns. What the drop costs is one tick of the status card, which the next hook post
        // supplies. The count is logged; the body is not, and nothing here has parsed it.
        refusals.warn(
          "hook post over the size cap",
          `${read.droppedBytes} bytes dropped unread`,
        );
        send(response, 202, { ignored: true });
        return;
      }

      const parsed = parseIntake(request, read.body);
      if ("unwatched" in parsed) {
        refusals.warn(
          "hook without a process token",
          "dropped; a session started without the launch wrapper is not watched",
        );
        send(response, 202, { ignored: true });
        return;
      }
      if ("failure" in parsed) {
        refusals.warn("hook rejected", parsed.failure.message);
        send(response, parsed.failure.status, { error: parsed.failure.message });
        return;
      }

      const record = options.registry.apply(parsed.intake);
      if (record === null && options.registry.impostorStart(parsed.intake)) {
        // A SessionStart carrying a session ID another process token still holds: the takeover
        // docs/security-model.md names, refused by the registry rather than merged. Its own reason
        // string, which is its own bucket in the rate limiter below, so a run of the ordinary drops
        // cannot be what turns this line into a suppressed count. The session named is the one the
        // post tried to claim, which is a record the broker already holds and publishes; the
        // process token is not logged, here or anywhere, because it is the key a hook post is
        // authenticated by, and a refused takeover is exactly the traffic a stolen one produces.
        refusals.warn(
          "SessionStart naming a session another process token holds",
          `session=${parsed.intake.sessionId ?? "none"} name=${parsed.intake.sessionName ?? "none"} ` +
            "(the takeover is refused; the session stays with the token that announced it)",
        );
        send(response, 202, { ignored: true });
        return;
      }
      if (record === null && options.registry.subprocessStart(parsed.intake)) {
        // A `claude` running as a subprocess of a wrapped session: it inherits CHANNEL_PROCESS_TOKEN
        // and announces a session of its own under it, and the registry declines to register it so
        // the parent keeps the token. Expected traffic rather than a fault, and it gets its own
        // line because the drop below names two causes that are both untrue of it, which would
        // read as a session mysteriously failing to register. The session named is unregistered and
        // appears on no other surface, which is why it is logged: it is the only handle anything
        // has on this drop. The process token is not logged, here or anywhere, because it is the
        // key a hook post is authenticated by.
        refusals.warn(
          "SessionStart from a subprocess",
          `session=${parsed.intake.sessionId ?? "none"} not registered; the session already ` +
            "holding this process token keeps it and goes on being mirrored",
        );
        send(response, 202, { ignored: true });
        return;
      }
      if (record === null) {
        // A tool or stop event from a process token with no announced session, or one whose session
        // ID and process token disagree (registry.route's session keying). Accepted off the wire and
        // dropped, so a replayed or misrouted post cannot conjure or corrupt a session. The process
        // token itself is never logged; it is the forgery key a hook post is authenticated by. Two
        // very different things land here: a forged or replayed post, and the ordinary tool and turn
        // traffic of a subprocess whose SessionStart was declined above, which names a session no
        // record holds for as long as that subprocess runs. So the line reports the cause and calls
        // what it caught neither.
        refusals.warn(
          "hook dropped",
          `event=${parsed.intake.event} session=${parsed.intake.sessionId ?? "none"} ` +
            `name=${parsed.intake.sessionName ?? "none"} (no session holds this process token, or ` +
            "the session id and process token disagree)",
        );
        send(response, 202, { ignored: true });
        return;
      }
      // Learned only from a post the registry credited to a record: an unwatched, forged, or
      // unroutable post must not aim the tailer at a file of its choosing under a session it does
      // not hold. Every credited event carries the path, so a broker restarted mid-session
      // re-learns it from the very next hook post.
      if (options.tail !== undefined && parsed.intake.transcriptPath !== null) {
        options.tail.learn(record.sessionId, parsed.intake.transcriptPath);
      }
      send(response, 200, { sessionId: record.sessionId, state: record.state });
    })().catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: "intake failed" });
      console.error(`broker: intake error: ${String(error)}`);
    });
  };
}
