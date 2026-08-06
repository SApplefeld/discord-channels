// The relay connections: one live pipe per Claude Code process, keyed by the process token that
// process was launched with.
//
// Three joins meet here and inverting any of them breaks the design. A relay is a child of the
// *process*, so it is keyed by process token and never by session: a `/clear` mints a new session
// on the same pipe. A thread is bound to a *session*, so the outbound direction goes through the
// registry to find which session that process currently holds. And the pipe closing and staying
// closed is the death signal for that session, because a hard kill fires no hook at all.
//
// What a process token is not, anywhere in this file, is authorization. Every shell subprocess a
// session spawns inherits it, so a token proves only which process a pipe claims to belong to.
// Two consequences are load-bearing:
//
//   - The **first** pipe for a token wins and holds it. A later attach carrying the same token is
//     refused rather than promoted, because promoting it would let a malicious postinstall script
//     take over the operator-to-Claude channel: it would receive the steering messages meant for
//     Claude and could answer as Claude.
//   - Each attachment is issued a **reply key**, sent down the pipe and never stored anywhere the
//     token holder can read. An outbound reply must carry it, so writing into the operator's thread
//     as Claude requires holding the pipe, not merely knowing the token.
import { randomUUID } from "node:crypto";
import type { Registry } from "../registry.ts";

/** What the broker writes down a relay's pipe. */
export type RelayEvent =
  /** First line on every attachment. Carries the key the relay must present to reply. */
  | { type: "hello"; replyKey: string }
  | {
      type: "message";
      /**
       * The Discord thread the message came from, carried to Claude as the channel event's
       * `chat_id`. Advisory only: a reply is routed by session, never by this.
       */
      chatId: string;
      text: string;
    }
  /** Liveness in both directions: it holds the session out of the sweep and proves the pipe drains. */
  | { type: "ping" };

/**
 * One relay's pipe, as the hub needs to see it. The seam is here so the routing is drivable with a
 * fake: nothing above it knows the pipe is an HTTP response being held open.
 */
export type RelayConnection = {
  /** Writes one event. False when the pipe would not take it, which is a dead relay. */
  send: (event: RelayEvent) => boolean;
  close: () => void;
};

export type AttachResult =
  | { attached: true; detach: () => void }
  | { attached: false; reason: "already attached" | "too many relays" };

export type RelayHub = {
  /**
   * Registers a pipe for a process token. Returns a detach function that is safe to call more than
   * once, or a refusal when this token already holds a live pipe or the broker is at its ceiling.
   */
  attach: (processToken: string, connection: RelayConnection) => AttachResult;
  /** True when a live pipe is held for this process token. */
  attached: (processToken: string) => boolean;
  /** True when this key is the one issued to the pipe currently held for this token. */
  holdsPipe: (processToken: string, replyKey: string) => boolean;
  /** Writes to the pipe held for a process token. False when there is none, or it would not take it. */
  deliver: (processToken: string, event: RelayEvent) => boolean;
  /**
   * Pings every attached relay, refreshes the liveness of the session each one holds, and ends the
   * session behind any pipe that has stayed closed past the grace window. A pipe that will not take
   * the ping is dropped, which runs the same path a stdio close does rather than a second one.
   */
  heartbeat: () => void;
  /** Closes every pipe without ending any session. For broker shutdown, which is not session death. */
  closeAll: () => void;
};

/**
 * Ceiling on pipes held at once. A host runs one to three sessions; anything approaching this is a
 * local process opening streams, and each one costs a socket and a heartbeat write forever.
 */
const MAX_RELAYS = 32;

export type RelayHubOptions = {
  registry: Registry;
  /**
   * How long a closed pipe is given to come back before its session is called dead. The relay
   * reconnects by design (the broker restarts at logon, and a read timeout drops a wedged stream),
   * so ending a session the instant a pipe closed would tombstone a working session permanently:
   * `ended` is terminal, and a re-attach goes through a lookup that skips ended records.
   */
  graceMs: number;
  /** Injected so a test drives the grace window without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
};

type Attachment = { connection: RelayConnection; replyKey: string };

/** A pipe that has gone, and the session it was watching, until the grace window closes. */
type Pending = { sessionId: string; since: number };

export function createRelayHub(options: RelayHubOptions): RelayHub {
  const connections = new Map<string, Attachment>();
  const pending = new Map<string, Pending>();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});

  /**
   * Drops a pipe and starts the grace window for the session it was watching, but only when that
   * pipe is still the registered one. A pipe that was already replaced or already dropped reports
   * nothing: its close is old news, and acting on it would end a session another pipe is serving.
   */
  function detach(processToken: string, connection: RelayConnection): void {
    if (connections.get(processToken)?.connection !== connection) return;
    connections.delete(processToken);

    const record = options.registry.current(processToken);
    // No announced session yet means nothing to end. The SessionStart hook has not arrived, or the
    // session it announced has already been superseded and ended.
    if (record === null) return;
    pending.set(processToken, { sessionId: record.sessionId, since: now() });
    log(`relay: the pipe for session ${record.sessionId} closed, ending it unless it comes back`);
  }

  /** Ends the sessions whose pipes stayed gone. Called on the heartbeat, which is its bound. */
  function reapPending(): void {
    const at = now();
    for (const [processToken, entry] of [...pending]) {
      if (connections.has(processToken)) {
        // The relay came back on the same token. Nothing died.
        pending.delete(processToken);
        continue;
      }
      if (at - entry.since < options.graceMs) continue;
      pending.delete(processToken);
      const record = options.registry.relayClosed(processToken, entry.sessionId);
      if (record !== null) log(`relay: session ${record.sessionId} is ended, its pipe did not come back`);
    }
  }

  return {
    attach(processToken, connection) {
      if (connections.has(processToken)) {
        // Refused, not promoted. Every tool subprocess a session spawns can read this token, and
        // promoting a newcomer would hand it the operator's messages and let it answer as Claude.
        log("relay: refused a second pipe for a process token that already holds one");
        return { attached: false, reason: "already attached" };
      }
      if (connections.size >= MAX_RELAYS) {
        log(`relay: refused a pipe, ${String(MAX_RELAYS)} relays are already attached`);
        return { attached: false, reason: "too many relays" };
      }

      const replyKey = randomUUID();
      connections.set(processToken, { connection, replyKey });
      // The relay is back before its grace window closed, so its session was never dead.
      pending.delete(processToken);
      // Liveness is recorded straight away: the pipe existing is the signal. A relay that connects
      // before its SessionStart hook has announced anything records nothing yet and is picked up by
      // the next heartbeat.
      options.registry.relaySeen(processToken);
      if (!connection.send({ type: "hello", replyKey })) {
        // The pipe was gone before the first line landed. Dropped here rather than left registered
        // holding the token against the relay that is about to retry.
        connections.delete(processToken);
        return { attached: false, reason: "already attached" };
      }
      return { attached: true, detach: () => detach(processToken, connection) };
    },

    attached: (processToken) => connections.has(processToken),

    holdsPipe: (processToken, replyKey) => {
      const attachment = connections.get(processToken);
      return attachment !== undefined && attachment.replyKey === replyKey;
    },

    deliver(processToken, event) {
      const attachment = connections.get(processToken);
      if (attachment === undefined) return false;
      if (attachment.connection.send(event)) return true;
      // The pipe is gone even though nothing reported it closed. Treated as a close, which is what
      // it is.
      detach(processToken, attachment.connection);
      return false;
    },

    heartbeat() {
      for (const [processToken, attachment] of [...connections]) {
        if (!attachment.connection.send({ type: "ping" })) {
          detach(processToken, attachment.connection);
          continue;
        }
        options.registry.relaySeen(processToken);
      }
      reapPending();
    },

    closeAll() {
      const open = [...connections.values()];
      // Cleared before anything is closed, so the close handlers find no registered pipe and end no
      // session. The broker stopping is not the sessions dying.
      connections.clear();
      pending.clear();
      for (const attachment of open) attachment.connection.close();
    },
  };
}
