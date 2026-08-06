// The loopback routes the relay speaks, alongside the hook intake on the same listener.
//
//   GET /relay/stream
//     X-Channel-Process-Token: the CHANNEL_PROCESS_TOKEN the launch wrapper minted
//     -> 200, newline-delimited JSON, held open for the life of the Claude Code process.
//        The first line is a `hello` carrying the reply key. Each later line is a RelayEvent.
//        The response closing, and staying closed, is the session's death signal.
//     -> 409 when this token already holds a pipe, or the broker is at its relay ceiling.
//
//   POST /relay/reply
//     X-Channel-Process-Token: the same token
//     X-Channel-Reply-Key:     the key the stream's `hello` carried
//     body: {"text": "..."}
//     -> 200 {"status": "sent" | "no-session" | "no-thread" | "failed"}
//     -> 403 when the key does not match the pipe currently held for that token
//
//   POST /relay/permission
//     the same two headers
//     body: {"request_id": "abcde", "tool_name": "...", "description": "...", "input_preview": "..."}
//     -> 200 {"status": "received" | "dropped"}, where dropped means the prompt never reached the
//        operator and no answer is coming
//     -> 403 on the same terms as a reply
//
//     The verdict does not come back on this response. It arrives whenever the operator answers,
//     down the stream as a `permission` event, because the answer can be minutes away and a
//     request held open that long is a socket the relay's own read timeout would drop.
//
// Two things about that shape are deliberate. The body carries no chat_id: routing by session is
// the design, and the way to make that true rather than merely intended is to give the wire no
// field to route by. And the reply key exists because a process token is not a credential: every
// shell subprocess a session spawns inherits it, so without the key any of them could post into the
// operator's thread as Claude. The key is issued per attachment and only ever written down the
// pipe, so presenting it means holding the pipe. A permission request is held to the same bar for
// a sharper reason: it is the one message the broker writes that rings the operator's phone and
// asks for a yes.
//
// Both guards the hook intake applies are applied here too, before anything is read: the socket
// peer must be loopback, and the Host header must name a loopback name, which is what closes DNS
// rebinding. They are re-checked rather than shared with the intake handler because these routes
// are composed in front of it and would otherwise be reachable without either.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedHost, isLoopback } from "../intake.ts";
import type { PermissionDesk } from "../security/permission.ts";
import type { OutboundRouter } from "./outbound.ts";
import type { RelayConnection, RelayEvent, RelayHub } from "./relays.ts";

/**
 * Most unwritten bytes a held-open stream may accumulate before it is treated as dead.
 *
 * A relay that attaches and stops reading would otherwise grow the broker's heap without bound:
 * `write` buffers in userspace once the kernel's send buffer fills and reports it only through a
 * return value. One event is a few hundred bytes, so this is a long way past any real backlog.
 */
const MAX_QUEUED_BYTES = 1 << 20;

export type RelayRoutesOptions = {
  relays: RelayHub;
  outbound: OutboundRouter;
  /**
   * The asking half of the permission desk and nothing else. This layer is what a local process
   * holding a pipe talks to, so handing it the answering half would put the ability to resolve a
   * prompt behind the pipe: a verdict is the operator's, and it arrives over Discord.
   */
  permissions: Pick<PermissionDesk, "request">;
  /** Hard cap on a reply body. A reply longer than a Discord message cannot be posted anyway. */
  maxBodyBytes: number;
  /**
   * How long a stream may go with no traffic at all before the broker drops it. The heartbeat is
   * traffic, so this only fires on a pipe that is already gone, and it is what stops a half-open
   * socket from holding a process token against the relay trying to reconnect on it.
   */
  streamIdleMs: number;
  log?: (message: string) => void;
};

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
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

/** The held-open response, as the hub sees it. */
function connectionOver(response: ServerResponse): RelayConnection {
  return {
    send: (event: RelayEvent) => {
      if (response.writableEnded || response.destroyed) return false;
      // Backpressure is not death on its own: `write` returning false means the buffer is filling,
      // and the event is still queued. A buffer past the cap is a peer that has stopped reading,
      // which is death, and reporting it as such is what stops the heap growing behind it.
      if (response.writableLength > MAX_QUEUED_BYTES) return false;
      response.write(`${JSON.stringify(event)}\n`);
      return true;
    },
    close: () => {
      if (!response.writableEnded) response.end();
      response.destroy();
    },
  };
}

/**
 * Returns a handler that reports whether it took the request, so the caller can fall through to the
 * hook intake for everything else.
 */
export function createRelayRoutes(
  options: RelayRoutesOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const log = options.log ?? ((): void => {});

  return (request, response) => {
    const route = (request.url ?? "/").split("?")[0];
    if (route !== "/relay/stream" && route !== "/relay/reply" && route !== "/relay/permission") {
      return false;
    }

    if (!isLoopback(request.socket.remoteAddress) || !isAllowedHost(request.headers.host)) {
      send(response, 403, { error: "loopback only" });
      return true;
    }

    const processToken = header(request, "x-channel-process-token");
    if (processToken === null) {
      send(response, 400, { error: "missing X-Channel-Process-Token" });
      return true;
    }

    if (route === "/relay/stream") {
      if (request.method !== "GET") {
        send(response, 405, { error: "method not allowed" });
        return true;
      }
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Without this a heartbeat sits in the kernel's Nagle buffer, and the relay's own read
      // timeout is what would fire rather than the ping arriving.
      request.socket.setNoDelay(true);
      response.flushHeaders();

      const attached = options.relays.attach(processToken, connectionOver(response));
      if (!attached.attached) {
        // Reported over a 200 that then closes, because the headers are already on the wire: the
        // stream had to be opened before the hub could be asked, or a refused attach would leave
        // the relay waiting on a response that never came.
        response.end(`${JSON.stringify({ type: "refused", reason: attached.reason })}\n`);
        return true;
      }
      // Any write resets this, and the heartbeat is a write, so it fires only on a pipe that has
      // stopped moving in both directions.
      response.setTimeout(options.streamIdleMs, () => {
        log("relay: a stream went idle past its timeout and was dropped");
        response.destroy();
      });
      // Both, because either end can be the one that goes: the request closes when the relay
      // process dies, and the response closes when the broker itself drops the pipe.
      request.on("close", attached.detach);
      response.on("close", attached.detach);
      log("relay: a relay attached");
      return true;
    }

    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" });
      return true;
    }

    // Checked before the body is read. Knowing the process token is not standing to write into the
    // operator's thread as Claude, or to ring their phone; holding the pipe is.
    const replyKey = header(request, "x-channel-reply-key");
    if (replyKey === null || !options.relays.holdsPipe(processToken, replyKey)) {
      log(`relay: refused a post to ${route} that did not come from the attached pipe`);
      send(response, 403, { error: "the reply key does not match the attached relay" });
      return true;
    }

    void (async () => {
      const body = await readBody(request, options.maxBodyBytes);
      if (body === null) {
        send(response, 413, { error: "body too large" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        send(response, 400, { error: "body is not valid JSON" });
        return;
      }
      const fields =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};

      if (route === "/relay/permission") {
        const request_id = fields.request_id;
        const tool_name = fields.tool_name;
        if (typeof request_id !== "string" || typeof tool_name !== "string") {
          send(response, 400, { error: "body has no request_id and tool_name" });
          return;
        }
        // The two descriptive fields are optional on the wire. They are written by a tool and are
        // the parts most likely to be missing or malformed, and a prompt that arrives without them
        // is still a prompt the session is parked on: refusing it would park the session for good.
        const accepted = await options.permissions.request(processToken, {
          requestId: request_id,
          toolName: tool_name,
          description: typeof fields.description === "string" ? fields.description : "",
          inputPreview: typeof fields.input_preview === "string" ? fields.input_preview : "",
        });
        // Reported honestly rather than always as taken. A relay told a prompt was received will
        // wait for a verdict that is never coming, and say nothing about it anywhere.
        send(response, 200, { status: accepted ? "received" : "dropped" });
        return;
      }

      const text = fields.text;
      if (typeof text !== "string") {
        send(response, 400, { error: "body has no text string" });
        return;
      }

      const result = await options.outbound.reply(processToken, text);
      send(response, 200, result);
    })().catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: "the request failed" });
      log(`relay: the ${route} route failed: ${String(error)}`);
    });
    return true;
  };
}
