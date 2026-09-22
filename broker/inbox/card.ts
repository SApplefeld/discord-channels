// The `Fleet: Inbox` card: one line per open item, oldest first, the way the store hands them over.
//
// Pure rendering, the board card's own discipline: everything it draws arrives as an argument, the
// current time included, so the same items always compose the same bytes and the thread this card
// lives in is edited only when its text changes.
//
// An item carries its session ID, its flag source and, where judged, which of the judge's two
// questions won. It carries neither the session's title nor its thread, because the inbox store
// knows nothing about the registry: those are read through `session`, a lookup the caller supplies
// on every render from the registry and the thread bindings, so this module depends on nothing but
// what it is handed. A session the lookup cannot resolve, which a prune racing a late judge verdict
// can leave behind, still draws a line: an ask silently missing from the one place the operator is
// meant to see it first is a worse failure than one drawn under a name built from its session ID,
// the same fallback `displayName` in `../discord/render.ts` falls back to.
//
// The session's title goes through `inertField`, which strips the invisible class exactly as
// `inertName` does and additionally escapes the live markdown this card's body renders; `inertName`
// alone is what a thread name takes, a surface that renders no markdown at all, and every caller of
// `displayName` that composes into a message body wraps its output the same way. The excerpt, the
// one string on this card a model can have written outside a fence, takes the same escape.
//
// A flagged reply's message ID draws as a jump link when the caller also knows the guild the card's
// channel sits in (`https://discord.com/channels/<guild>/<thread>/<message>`), and as a channel
// mention chip (`<#thread>`) otherwise: a chip needs only the thread's own ID and Discord still
// renders it as a working link into the thread, so an item with a resolved thread and no usable
// link still draws somewhere to go. Every identifier composed into either form is checked against
// `SNOWFLAKE` first, since both are string interpolations into Discord syntax a hostile value could
// otherwise steer.
import { fit, heartbeat, inertField, inertName, MAX_CARD_LENGTH } from "../discord/render.ts";
import { MAX_EXCERPT_CODE_POINTS } from "./ask.ts";
import { SNOWFLAKE } from "../security/senders.ts";
import type { InboxItem } from "./store.ts";

/** One session as the card needs to know it, read fresh on every render. */
export type InboxCardSession = {
  /** The session's own title, unescaped: what a `custom-title` transcript line or a launch name set,
   * or the store's own stub for a session that never set either. */
  title: string;
  /** The thread the session's replies land in, or null before it has one. */
  threadId: string | null;
  /** Whether the session has ended. An ended record keeps its item, drawn with a marker of its own,
   * because an act such as a merge outlives the session that asked for it. */
  ended: boolean;
};

/** Looks up one session's card-drawing facts by ID. Returns undefined for a session this tick's
 * caller could not resolve, which the card still draws a line for rather than dropping silently. */
export type InboxSessionLookup = (sessionId: string) => InboxCardSession | undefined;

/** The card's name where Discord draws a message's first line, inline beside the bot's own name,
 * and again at the largest heading Discord offers, for the two reasons the sibling cards' comments
 * give: that position reads as chrome, and a channel of cards needs a visible top edge. */
const PREVIEW = "📥 **Fleet: Inbox**";
const TITLE = "# 📥 Fleet: Inbox";

/** What a card with nothing open says, rather than being absent: an absent card and a fleet with
 * nothing outstanding look identical to a reader, and only one of them is good news. */
const EMPTY = "No open asks.";

const SEPARATOR = "·";
const BULLET = "-";
const SUB_BULLET = "  -";

/** The glyph an item draws for the way it was flagged: the session's own word, or which of the
 * judge's two questions won. */
const MARK_GLYPH = "📝";
const REPLY_GLYPH = "💬";
const ACT_GLYPH = "⚡";

/** What an ended session's item is marked with, past its age. */
const ENDED_MARKER = "ended";

/** Room for a session's title, whether read off the session or built from its ID: wide enough for a
 * name written to be read, on the board card's own persona-name width. */
const MAX_TITLE_LENGTH = 60;

/**
 * How much longer than its input the live-markdown escape can make a field, as a multiple of the
 * input's length in code points, on `../board/card.ts`'s own reasoning: every character the escape
 * touches is ASCII and every astral one it leaves untouched, so a field already held to N code
 * points renders whole under N times this.
 */
const MAX_ESCAPE_EXPANSION = 2;

/** An untrusted field already bounded by its own producer: escaped and guarded, never re-cut. */
function field(value: string, cap: number): string {
  return inertField(value, cap * MAX_ESCAPE_EXPANSION);
}

/** An untrusted field this card holds to a cap of its own: cut, then escaped. */
function cutField(value: string, cap: number): string {
  return inertField(fit(value, cap), cap * MAX_ESCAPE_EXPANSION);
}

/** The name a session with no resolvable record draws under, the same fallback `displayName` in
 * `../discord/render.ts` falls back to for a session with neither a title nor a launch name.
 * Neutralized before it is cut rather than after, `displayName`'s own reasoning: a slice of raw
 * text can end mid-override. */
function unresolvedTitle(sessionId: string): string {
  return `session ${inertName(sessionId).slice(0, 8)}`;
}

function glyphFor(item: InboxItem): string {
  if (item.source === "marked") return MARK_GLYPH;
  return item.winner === "needs_act" ? ACT_GLYPH : REPLY_GLYPH;
}

/** What a card that ran out of room ends with, naming how many items it left out rather than
 * cutting silently. */
function overflowTail(remaining: number): string {
  return `(+${remaining} more ask${remaining === 1 ? "" : "s"} not shown)`;
}

/** What a run of lines costs the card: each line's own text and the newline that joins it on. */
function spent(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + 1 + line.length, 0);
}

/** A value checked against Discord's own identifier shape, or null when it is not one: the guard
 * every identifier here takes before it is interpolated into a link or a chip. */
function snowflake(value: string | null): string | null {
  return value !== null && SNOWFLAKE.test(value) ? value : null;
}

/**
 * Where an item's flagged reply points: a jump link when the caller knows the guild the card's
 * channel sits in and the flag carried a message ID, or a channel mention chip to the thread when
 * either is missing, or null when even the thread is unknown. Every identifier drawn is checked
 * against `SNOWFLAKE` first, since both forms interpolate it into Discord syntax.
 */
function itemLink(
  guildId: string | null,
  threadId: string | null,
  messageId: string | null,
): string | null {
  const thread = snowflake(threadId);
  if (thread === null) return null;
  const guild = snowflake(guildId);
  const message = snowflake(messageId);
  if (guild !== null && message !== null) {
    return `https://discord.com/channels/${guild}/${thread}/${message}`;
  }
  return `in <#${thread}>`;
}

/**
 * One item's lines: its session's title in bold on a bullet of its own, marked with the glyph its
 * flag source draws, its age, a link to its thread or its flagged message where one is known, and
 * an ended marker where its session has ended; a marked item with something in its excerpt draws
 * that on a sub-bullet under it.
 */
function itemLines(
  item: InboxItem,
  session: InboxCardSession | undefined,
  guildId: string | null,
  now: number,
): string[] {
  const named = session === undefined ? "" : cutField(session.title, MAX_TITLE_LENGTH);
  const title = named === "" ? cutField(unresolvedTitle(item.sessionId), MAX_TITLE_LENGTH) : named;
  // Drawn from when the ask opened rather than when it was last refreshed: items draw oldest opened
  // first, and an age keyed to the latest refresh would show a restated ask as "just now" above a
  // younger one it is drawn beneath.
  const age = heartbeat(Math.max(now - item.openedAt, 0));
  const parts = [`${glyphFor(item)} **${title}**`, age];
  const link = itemLink(guildId, session?.threadId ?? null, item.messageId);
  if (link !== null) parts.push(link);
  if (session?.ended === true) parts.push(ENDED_MARKER);
  const lines = [`${BULLET} ${parts.join(` ${SEPARATOR} `)}`];
  if (item.excerpt !== null && item.excerpt !== "") {
    lines.push(`${SUB_BULLET} "${field(item.excerpt, MAX_EXCERPT_CODE_POINTS)}"`);
  }
  return lines;
}

/**
 * The whole card: a title heading, one bullet per item oldest first, or the fixed empty line, bounded
 * to one message the way every card here is. Composed item by item against a running budget rather
 * than assembled whole and cut, so a stop names how many items it left out instead of dropping the
 * last one silently; the tail's room is reserved against every item, the last included, on the board
 * card's own reasoning: one rule with no branch to get wrong, at the price of at most one tail's
 * width of unused room on a full card.
 *
 * Nothing here reads a clock or anything else `input` does not carry, so two renders of the same
 * items compose the same bytes.
 */
export function renderInboxCard(input: {
  /** Every open item, oldest opened first: `InboxStore.items()`'s own order. */
  items: readonly InboxItem[];
  session: InboxSessionLookup;
  /** The guild the card's channel sits in, or null while the gateway has not cached it yet. Null
   * makes every item's link fall back to its thread's channel mention chip. */
  guildId: string | null;
  now: number;
}): string {
  const lines: string[] = [PREVIEW, TITLE];
  if (input.items.length === 0) {
    lines.push(EMPTY);
    return lines.join("\n");
  }
  let used = spent(lines);
  let shown = 0;
  for (const item of input.items) {
    const drawn = itemLines(item, input.session(item.sessionId), input.guildId, input.now);
    const cost = spent(drawn);
    const tail = overflowTail(input.items.length - shown);
    if (used + cost + spent([tail]) > MAX_CARD_LENGTH) {
      lines.push(tail);
      return lines.join("\n");
    }
    lines.push(...drawn);
    used += cost;
    shown += 1;
  }
  return lines.join("\n");
}
