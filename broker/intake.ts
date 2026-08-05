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
//     body: the hook payload verbatim, exactly as Claude Code emits it
//
// The event name rides in a header rather than the body because two of the three hooks are `http`
// hooks, whose body is authored by Claude Code and cannot be wrapped. A header is static per hook
// declaration, so each declaration names its own event, and the SessionStart `command` hook posts
// its stdin with the same three headers. One shape for all three transports.
//
//   GET /sessions  -> the registry as JSON, for debugging.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookEvent, HookIntake, Registry, SessionRecord } from "./registry.ts";
import { clean } from "./sanitize.ts";

const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "PostToolUse", "Stop"];

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

export type IntakeFailure = { status: number; message: string };

export function parseIntake(
  request: IncomingMessage,
  body: string,
): { intake: HookIntake } | { failure: IntakeFailure } {
  const event = header(request, "x-channel-hook-event");
  if (event === null || !HOOK_EVENTS.includes(event as HookEvent)) {
    return { failure: { status: 400, message: "unknown or missing X-Channel-Hook-Event" } };
  }

  const processToken = header(request, "x-channel-process-token");
  if (processToken === null) {
    return { failure: { status: 400, message: "missing X-Channel-Process-Token" } };
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
      // tool_input and tool_response are deliberately dropped: unbounded, untrusted, and of no use
      // to any surface the broker renders.
      toolName: payloadString(fields, "tool_name"),
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

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBodyBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type HandlerOptions = {
  registry: Registry;
  maxBodyBytes: number;
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
  return (request, response) => {
    // Both checks run before the body is read, so a refused request cannot reach the registry.
    if (!isLoopback(request.socket.remoteAddress)) {
      send(response, 403, { error: "loopback only" });
      return;
    }

    // Closes DNS rebinding, where the socket peer is loopback but the page that opened it is not.
    if (!isAllowedHost(request.headers.host)) {
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

    if (request.method !== "POST" || route !== "/hook") {
      send(response, 404, { error: "not found" });
      return;
    }

    void (async () => {
      const body = await readBody(request, options.maxBodyBytes);
      if (body === null) {
        send(response, 413, { error: "body too large" });
        return;
      }

      const parsed = parseIntake(request, body);
      if ("failure" in parsed) {
        send(response, parsed.failure.status, { error: parsed.failure.message });
        return;
      }

      const record = options.registry.apply(parsed.intake);
      if (record === null) {
        // A tool or stop event from a process token with no announced session. Accepted off the
        // wire and dropped, so a replayed post cannot conjure a session that never started.
        send(response, 202, { ignored: true });
        return;
      }
      send(response, 200, { sessionId: record.sessionId, state: record.state });
    })().catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: "intake failed" });
      console.error(`broker: intake error: ${String(error)}`);
    });
  };
}
