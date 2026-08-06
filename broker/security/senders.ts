// Who is allowed to put text in front of a running session.
//
// The gate is on the Discord user ID of a message's author, never on the channel or the thread it
// was posted in. A thread identifies a room, and everyone with access to the room can post in it,
// so treating the room as the credential would let any of them steer a session and approve its
// tool calls. The author's ID is the only thing an inbound message carries that says who wrote it.
//
// It is also the only authority for anything inbound. A process token identifies which Claude Code
// process a pipe belongs to and is inherited by every subprocess a session spawns; it authenticates
// reports about a session and never instructions to one.
//
// One operator per host, and the allowlist is required. A broker with a Discord connection and no
// allowed user refuses to start rather than running a gate that admits everyone, because a gate
// that was misconfigured and a gate that was never wired look identical from the outside.

export type SenderGate = {
  /** True for the one user whose messages this broker acts on. */
  allows: (senderId: string) => boolean;
  /**
   * The operator. The only ID any message this broker writes is allowed to resolve as a mention,
   * which is what keeps a deliberate ping from becoming a mention primitive for untrusted text.
   */
  operatorId: string;
};

/** Discord identifiers are snowflakes. Shared with the channel ID's check in discord/config.ts. */
export const SNOWFLAKE = /^\d{17,20}$/;

export function createSenderGate(operatorId: string): SenderGate {
  const allowed = operatorId.trim();
  return {
    // The empty case is checked rather than assumed away: nothing reaching here should carry an
    // empty ID, and if something ever does, it admits nobody instead of everybody.
    allows: (senderId) => allowed !== "" && senderId.trim() === allowed,
    operatorId: allowed,
  };
}

/**
 * The gate for a broker that has a Discord connection. Throws when the allowlist is missing or is
 * not a snowflake, which stops the broker at startup: an unreadable allowlist is the one failure
 * that must not be survived quietly, since surviving it means running without one.
 */
export function loadSenderGate(env: NodeJS.ProcessEnv): SenderGate {
  const raw = env.CHANNEL_ALLOWED_USER_ID?.trim();
  if (!raw) {
    throw new Error(
      "CHANNEL_ALLOWED_USER_ID must name the Discord user allowed to steer this host's sessions; " +
        "without it every message in the channel would reach a running session",
    );
  }
  if (!SNOWFLAKE.test(raw)) {
    throw new Error(
      `CHANNEL_ALLOWED_USER_ID must be a Discord snowflake, got ${JSON.stringify(raw)}`,
    );
  }
  return createSenderGate(raw);
}
