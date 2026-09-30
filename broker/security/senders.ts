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
// Each host admits a short roster of IDs, each holding one class: an operator, whose word is the
// host owner's, or a participant, who may talk to a session and holds no more than that. An ID
// holds exactly one class, and an ID the roster does not name is refused. The roster is required
// and must name at least one operator. A broker with a Discord connection and no operator refuses
// to start rather than running a gate that admits everyone, because a gate that was misconfigured
// and a gate that was never wired look identical from the outside.

export type SenderClass = "operator" | "participant";

export type SenderEntry = { id: string; class: SenderClass };

export type SenderGate = {
  /** The class the roster gives this user, or null for anyone it does not name. */
  classOf: (senderId: string) => SenderClass | null;
  /** True for every user the roster names, whatever their class. */
  allows: (senderId: string) => boolean;
  /**
   * Every operator, in roster order. The only IDs any message this broker writes is allowed to
   * resolve as mentions, which is what keeps a deliberate ping from becoming a mention primitive for
   * untrusted text. Empty when the roster names no operator, which loadSenderGate never returns.
   * Nothing caps its length. Every alert mentions each operator, and the two long enough to reach
   * the message ceiling, the permission prompt and the question prompt, take each further mention's
   * room out of their own longest field. Each alert stays one message on a roster of up to thirty
   * operators, the smallest bound any alert's arithmetic states (the question notice's).
   */
  operatorIds: readonly string[];
  /** Every participant, in roster order. */
  participantIds: readonly string[];
};

/** Discord identifiers are snowflakes. Shared with the channel ID's check in discord/config.ts. */
export const SNOWFLAKE = /^\d{17,20}$/;

/**
 * A gate over the given roster. An ID repeated with the same class is one entry, and an ID repeated
 * with two classes throws, since letting either win by order would silently promote a participant
 * or demote an operator.
 */
export function createSenderGate(entries: readonly SenderEntry[]): SenderGate {
  const classes = new Map<string, SenderClass>();
  for (const entry of entries) {
    const id = entry.id.trim();
    // The empty case is checked rather than assumed away: nothing reaching here should carry an
    // empty ID, and if something ever does, it admits nobody instead of everybody.
    if (id === "") continue;
    const held = classes.get(id);
    if (held !== undefined && held !== entry.class) {
      throw new Error(
        `sender ${id} is listed as both ${held} and ${entry.class}; an ID holds one class`,
      );
    }
    classes.set(id, entry.class);
  }
  const idsOf = (wanted: SenderClass) =>
    [...classes].filter(([, held]) => held === wanted).map(([id]) => id);
  const operatorIds = idsOf("operator");
  const classOf = (senderId: string): SenderClass | null => {
    const id = senderId.trim();
    if (id === "") return null;
    return classes.get(id) ?? null;
  };
  return {
    classOf,
    allows: (senderId) => classOf(senderId) !== null,
    operatorIds,
    participantIds: idsOf("participant"),
  };
}

/**
 * The gate for a broker that has a Discord connection. Reads CHANNEL_ALLOWED_USER_ID as one
 * operator and CHANNEL_SENDERS as a comma-separated list of `<snowflake>:<operator|participant>`,
 * and admits the union, with the first variable's operator listed first. Throws when an ID is not a
 * snowflake, a class is not one of the two words, an ID is given two classes, or no operator
 * results, which stops the broker at startup: an unreadable allowlist is the one failure that must
 * not be survived quietly, since surviving it means running without one. Each refusal names the
 * entry it refused, which is an ID and a word and never a credential.
 */
export function loadSenderGate(env: NodeJS.ProcessEnv): SenderGate {
  const entries: SenderEntry[] = [];
  const allowed = env.CHANNEL_ALLOWED_USER_ID?.trim();
  if (allowed) {
    if (!SNOWFLAKE.test(allowed)) {
      throw new Error(
        `CHANNEL_ALLOWED_USER_ID must be a Discord snowflake, got ${JSON.stringify(allowed)}`,
      );
    }
    entries.push({ id: allowed, class: "operator" });
  }
  const listed = env.CHANNEL_SENDERS?.trim();
  if (listed) {
    for (const raw of listed.split(",")) {
      const entry = raw.trim();
      const colon = entry.indexOf(":");
      const id = (colon < 0 ? entry : entry.slice(0, colon)).trim();
      const named = colon < 0 ? "" : entry.slice(colon + 1).trim();
      if (!SNOWFLAKE.test(id)) {
        throw new Error(
          `CHANNEL_SENDERS entry ${JSON.stringify(entry)} must start with a Discord snowflake`,
        );
      }
      if (named !== "operator" && named !== "participant") {
        throw new Error(
          `CHANNEL_SENDERS entry ${JSON.stringify(entry)} must end in :operator or :participant`,
        );
      }
      entries.push({ id, class: named });
    }
  }
  const gate = createSenderGate(entries);
  if (gate.operatorIds.length === 0) {
    throw new Error(
      "CHANNEL_ALLOWED_USER_ID or an operator in CHANNEL_SENDERS must name the Discord user " +
        "allowed to steer this host's sessions; without one every message in the channel would " +
        "reach a running session",
    );
  }
  return gate;
}
