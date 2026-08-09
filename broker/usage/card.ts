// The fleet card: one bounded message body carrying every account's usage and every live session
// on this host.
//
// Pure rendering. Everything it draws arrives as arguments, including the current time, so the same
// inputs always compose the same body: the thread this card lives in is edited only when its text
// actually changes, and a clock read inside the renderer would be a difference on every refresh.
//
// Freshness is displayed rather than manufactured. Each account carries the age of the numbers
// beside them, derived here from the cache's own fetch time, and reset countdowns are derived from
// the reset instant rather than repeated from the strings claude-swap computed when it fetched. An
// account whose polling is failing or backing off carries a warning line beside its numbers, so the
// numbers are never presented as fresher than they are.
//
// One consequence is worth knowing before comparing a rendered card against the cache file it came
// from: a weekly or per-model row whose reset instant has passed is drawn for the period it is in
// now, at zero percent against the next boundary, rather than at the percentage the cache last
// wrote against a boundary that is gone. The reset cadence is fixed and the cache states it, so this
// reads what the file says rather than adding to it, and it is what claude-swap's own console shows
// for the same window. The 5h window is never rolled this way.
//
// Every string that came out of the cache or off a session is untrusted: the cache is another
// program's file and a session names itself whatever it likes. All of them go through
// `../discord/render.ts`'s escaping, which is where display safety lives for every surface this
// broker draws, and the glyphs and the session label come from that same module so the card and the
// thread title cannot disagree about what a session is called or what state it is in.
import {
  FENCE_COST,
  GLYPHS,
  MAX_BLOCK_WIDTH,
  MAX_CARD_LENGTH,
  alignedRows,
  columnWidth,
  displayName,
  fenced,
  heartbeat,
  inertBlockField,
  span,
  wrapped,
} from "../discord/render.ts";
import type { BlockRow } from "../discord/render.ts";
import { deriveSurfaceState } from "../discord/state.ts";
import type { SessionView, StateThresholds, SurfaceState } from "../discord/state.ts";
import type { UsageAccount, UsageReading, UsageUnavailableReason, UsageWindow } from "./cache.ts";

/** Room for the untrusted fields, cut before the body is assembled the way every card field is. */
export const MAX_ACCOUNT_LABEL_LENGTH = 60;
export const MAX_SCOPED_NAME_LENGTH = 24;
export const MAX_CURRENCY_LENGTH = 8;
export const MAX_SESSION_NAME_LENGTH = 60;

/**
 * The percentage at which a window carries a warning glyph. At or past it, a limit is close enough
 * that the operator's next decision depends on it.
 */
export const WARNING_PCT = 90;

/**
 * The largest percentage the card will draw. The cache's numbers come from another program and are
 * only ever bounded by what that program wrote, so a nonsense value is bounded here rather than
 * allowed to render a twenty-digit figure that pushes every other line off the card.
 */
export const MAX_DRAWN_PCT = 999;

/**
 * How far ahead of the current time a fetch time may sit and still be believed. Small clock
 * disagreement between the writer of the cache and the reader of it is ordinary; past this, the
 * timestamp is not describing a past measurement and nothing can be derived from it.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * The pace marker's rule, mirroring claude-swap's own `pace.py` so the card and the console cannot
 * disagree about which window is running hot: a weekly period, elapsed time measured from the
 * reading's fetch time rather than from now, no marker inside the first day of a window, and a flat
 * fifteen-point gap before "ahead" means anything.
 */
export const PACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;
export const PACE_SUPPRESS_AFTER_RESET_MS = 24 * 60 * 60 * 1_000;
export const PACE_AHEAD_THRESHOLD_PCT = 15;

const SEPARATOR = "·";
// The one line outside the fence, because it is what the channel list and a notification show, and
// Discord draws no bold inside a block. Everything below it is the card's body, which is a table.
const HEADING = "📊 **Fleet: Usage**";
const SESSIONS_HEADING = "Sessions";
const NO_ACCOUNTS = `⚠ usage unavailable ${SEPARATOR} the usage cache holds no accounts`;

/** What a scoped row is called when the cache's name for it neutralizes to nothing. */
const UNNAMED_SCOPE = "per-model";

/** What an unavailable reading says, one static phrase per reason. */
const UNAVAILABLE: Record<UsageUnavailableReason, string> = {
  unreadable: "the usage cache cannot be read on this host",
  oversized: "the usage cache is larger than this reader will open",
  malformed: "the usage cache does not parse",
};

/**
 * ` · resets 3h 44m` for a window that carries a reset time, and nothing at all for one that does
 * not, which is the shape claude-swap really writes for some accounts. A reset instant already
 * behind the current time renders as due rather than as a countdown running backwards: the cache
 * can be older than the window it describes.
 */
function resetsClause(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return "";
  const remaining = window.resetsAt - now;
  return ` ${SEPARATOR} resets ${remaining <= 0 ? "due" : span(remaining)}`;
}

/** The percentage as the card draws it: whole, and inside a range a line can carry. */
function drawnPct(pct: number): number {
  return Math.min(Math.max(Math.round(pct), 0), MAX_DRAWN_PCT);
}

/**
 * A weekly window whose reset instant has passed, advanced to the period it is actually in now: the
 * boundary moved forward by whole weeks until it lands in the future, and the percentage at zero.
 *
 * Weekly limits reset on a fixed seven-day cadence, so a reset time in the past is the cache telling
 * this reader that the window it measured no longer exists. Reading that is not manufacturing
 * freshness, it is using a fact the cache itself wrote: the alternative draws last period's spend
 * against a boundary that is gone, which reports an operator out of headroom at the exact moment
 * they have a full week of it. That failure inverts what the card is for, so it decides the shape
 * here. The 5h window is left alone, as it is for pace: its cadence is not this one.
 *
 * A reading whose fetch time is not believable rolls nothing. Without a trustworthy measurement time
 * there is no ground for asserting a fresh period, and the card says the age is unknown rather than
 * drawing a confident zero over a reading it has just declined to date.
 */
function rolledWeekly(window: UsageWindow, fetchedAt: number | null, now: number): UsageWindow {
  if (fetchedAt === null || window.resetsAt === null || window.resetsAt > now) return window;
  const missed = Math.floor((now - window.resetsAt) / PACE_PERIOD_MS) + 1;
  return { pct: 0, resetsAt: window.resetsAt + missed * PACE_PERIOD_MS };
}

/**
 * Whether a weekly window has spent more of its budget than the fraction of the week that has gone
 * by, and by enough of a margin to be worth saying.
 *
 * The rule is claude-swap's, constant for constant, because the operator reads both surfaces and a
 * marker on one and not the other reads as a bug in whichever they trust less. Three of its choices
 * carry the weight. Elapsed time is measured from `fetchedAt`, so a reading served stale is judged
 * against the clock it was actually taken at rather than against a week that has moved on without
 * it. The first day after a reset shows nothing, because a small elapsed fraction makes almost any
 * usage read as far ahead. And the gap is a flat fifteen points rather than a ratio, which also
 * means the marker stops firing in the last stretch of the week, where the percentage itself already
 * tells the story.
 *
 * It runs on the rolled window, as upstream's does. A window carried into a period it did not
 * measure has no current-cycle spend to compare against, and its zero can never be fifteen points
 * ahead of anything, so the roll is what keeps last period's high percentage from being marked
 * against this period's clock.
 *
 * The comparison runs on the raw percentage rather than the drawn one, matching upstream: the drawn
 * value governs the warning glyph, where the operator can see the number the threshold was read off.
 */
function aheadOfPace(window: UsageWindow, fetchedAt: number | null): boolean {
  if (fetchedAt === null || window.resetsAt === null) return false;
  // Floored rather than the language's own remainder, which takes the sign of its left operand. The
  // gap is negative whenever a reset sits behind the fetch that observed it, and a negative
  // remainder there would place the window's start in the future and read the pace off the wrong
  // cycle.
  const gap = window.resetsAt - fetchedAt;
  const remaining = ((gap % PACE_PERIOD_MS) + PACE_PERIOD_MS) % PACE_PERIOD_MS;
  const elapsed = remaining === 0 ? 0 : PACE_PERIOD_MS - remaining;
  if (elapsed < PACE_SUPPRESS_AFTER_RESET_MS) return false;
  const expected = Math.min(100, (elapsed / PACE_PERIOD_MS) * 100);
  return window.pct - expected >= PACE_AHEAD_THRESHOLD_PCT;
}

/**
 * One window's value, drawn beside its own name in the block's label column.
 *
 * The warning is decided on the percentage as it renders, not on the raw one, so two rows drawn as
 * `90%` are never marked differently: a threshold read off a number the operator cannot see is a
 * card that looks inconsistent with itself. The glyph leads the value rather than the name, because
 * the names are the column that does the aligning and an emoji in it is not one column wide.
 */
function windowValue(window: UsageWindow, now: number, ahead: boolean): string {
  const pct = drawnPct(window.pct);
  const pace = ahead ? ` ${SEPARATOR} ahead of pace` : "";
  return `${pct >= WARNING_PCT ? "⚠ " : ""}${pct}%${resetsClause(window, now)}${pace}`;
}

/**
 * What an account is called: its address, its organization name, or its slot number. The slot
 * number is the one part that is this broker's own, so it is what the label falls back to when
 * `sequence.json` was unreadable or when the identity it held neutralizes to nothing.
 *
 * Bounded by what its own line leaves rather than by the field cap alone, since the heading is one
 * line of a block whose width is fixed.
 */
function accountLabel(account: UsageAccount, room: number): string {
  const limit = Math.min(MAX_ACCOUNT_LABEL_LENGTH, Math.max(room, 0));
  const named = inertBlockField(account.email ?? account.organizationName ?? "", limit);
  return named === "" ? `account ${account.number}` : named;
}

/**
 * When the account's numbers were measured, or null when nothing can be derived from the timestamp
 * the cache carries.
 *
 * A fetch time in the future is the case worth naming: clamping it to zero would draw the staleest
 * possible cache as "as of just now", which is exactly the fresh-looking stale card the age line
 * exists to prevent. Small skew is tolerated, because two clocks agreeing to the second is not
 * something a reader can require of a file another program wrote.
 */
function measuredAt(account: UsageAccount, now: number): number | null {
  if (account.fetchedAt === null || account.fetchedAt > now + MAX_CLOCK_SKEW_MS) return null;
  return account.fetchedAt;
}

/**
 * The currency symbols this card knows, keyed by the code the cache writes. Tiny on purpose: USD
 * is the only code the live cache has ever carried. A symbol is substituted only on an exact match
 * against this map, never composed from the cache's own string, and a code with no entry keeps
 * today's shape, the bounded code drawn after the amount. A Map rather than an object so an
 * untrusted code can never reach a prototype property.
 */
const CURRENCY_SYMBOLS = new Map([["USD", "$"]]);

/**
 * A money amount as the card draws it: the integer part grouped in threes, two decimal places, and
 * a trailing `.00` dropped, so 95.4 draws as `95.40` and 1500 as `1,500`. The cache's numbers
 * arrive as JSON doubles, so a sum of fractional charges reaches this renderer as
 * `0.30000000000000004`, and rounding to the cent is what a currency amount means.
 *
 * Formatted by hand rather than through `toLocaleString`, because the rendered body must depend on
 * nothing but the inputs: the card's byte-compare change detection rests on identical inputs
 * producing identical bytes, and a locale that groups with periods or swaps the decimal separator
 * would also silently change what the operator reads.
 */
function amount(value: number): string {
  const cents = Math.round(value * 100);
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  const whole = String(Math.trunc(magnitude / 100)).replace(/\B(?=(\d{3})+$)/g, ",");
  const fraction = magnitude % 100;
  return `${sign}${whole}${fraction === 0 ? "" : `.${String(fraction).padStart(2, "0")}`}`;
}

/**
 * One account's block: a heading carrying the marker, the label, and the age, then a row per window.
 *
 * The heading is a line of its own rather than a labelled row, so a long address is cut on its own
 * line instead of taking the column every window's numbers are drawn in. Its marker leads the line,
 * where a glyph's width costs nothing but its own column.
 */
function accountRows(account: UsageAccount, now: number): BlockRow[] {
  const fetchedAt = measuredAt(account, now);
  const age = fetchedAt === null ? "unknown" : heartbeat(Math.max(now - fetchedAt, 0));
  const marker = account.active ? "▶" : SEPARATOR;
  const suffix = ` ${SEPARATOR} as of ${age}`;
  const label = accountLabel(account, MAX_BLOCK_WIDTH - [...marker].length - 1 - [...suffix].length);
  const rows: BlockRow[] = [{ label: null, value: `${marker} ${label}${suffix}` }];
  // The 5h window carries no pace marker at any percentage, and no roll either: it resets too fast
  // for a pace reading to mean anything, and its cadence is not the weekly one the roll advances by.
  if (account.fiveHour !== null) {
    rows.push({ label: "5h", value: windowValue(account.fiveHour, now, false) });
  }
  if (account.sevenDay !== null) {
    const seven = rolledWeekly(account.sevenDay, fetchedAt, now);
    rows.push({ label: "7d", value: windowValue(seven, now, aheadOfPace(seven, fetchedAt)) });
  }
  for (const row of account.scoped) {
    const scoped = { ...row, ...rolledWeekly(row, fetchedAt, now) };
    // A maxed per-model limit carries the warning glyph alone. Being ahead of pace is a forecast, and
    // it says nothing beside a window that has already arrived where the forecast pointed.
    const ahead = scoped.pct < 100 && aheadOfPace(scoped, fetchedAt);
    const name = inertBlockField(scoped.name, MAX_SCOPED_NAME_LENGTH);
    rows.push({
      label: name === "" ? UNNAMED_SCOPE : name,
      value: windowValue(scoped, now, ahead),
    });
  }
  if (account.spend !== null) {
    const symbol =
      account.spend.currency === null ? null : (CURRENCY_SYMBOLS.get(account.spend.currency) ?? null);
    // The amounts are shown only when both sides of the ratio are readable: a spend of 95.4 with no
    // limit beside it says nothing the percentage has not already said. A known currency's symbol
    // leads each amount; an unknown code trails the pair instead.
    const amounts =
      account.spend.used === null || account.spend.limit === null
        ? ""
        : ` ${SEPARATOR} ${symbol ?? ""}${amount(account.spend.used)} of ${symbol ?? ""}${amount(account.spend.limit)}`;
    const currency =
      account.spend.currency === null || symbol !== null || amounts === ""
        ? ""
        : ` ${inertBlockField(account.spend.currency, MAX_CURRENCY_LENGTH)}`;
    // The same threshold and the same rounding the window lines use: a credit limit is a limit, and
    // an operator scanning for what is close to running out reads one glyph, not two rules.
    const pct = drawnPct(account.spend.pct);
    rows.push({
      label: "spend",
      value: `${pct >= WARNING_PCT ? "⚠ " : ""}${pct}%${amounts}${currency}`,
    });
  }
  // Backing off is an instant that has not arrived yet, not a field that is set: claude-swap leaves
  // the timestamp behind after the pause it describes has elapsed.
  const backingOff = account.backoffUntil !== null && now < account.backoffUntil;
  if (account.failing || backingOff) {
    // Beside the numbers rather than instead of them: the last good reading is still the best
    // answer available, and what the operator needs to know is that nothing newer is coming. The
    // cache's own error text is never carried, only that there is one.
    const trouble = [account.failing ? "failing" : null, backingOff ? "backing off" : null]
      .filter((part) => part !== null)
      .join(` ${SEPARATOR} `);
    // The count rides along only when there is one to state. A warning reading "0 consecutive" beside
    // it contradicts itself, and a backoff can outlive the failure count that opened it.
    const count =
      account.consecutiveFailures > 0 ? ` ${SEPARATOR} ${account.consecutiveFailures} consecutive` : "";
    // A whole-width line rather than a row: it is a sentence about the account, not a number in the
    // column, and it wraps rather than being cut, because the part that names the trouble is the
    // whole point of it.
    rows.push({ label: null, value: `⚠ usage checks ${trouble}${count}` });
  }
  return rows;
}

/**
 * One live session: the state glyph, the name, the state, and how long since it last reported.
 *
 * A whole-width line, with the name cut to what the rest of it leaves. The glyph leads, the way it
 * leads a thread title, and the state and the age are what the name gives way to: a session's name
 * is the field this broker does not size, and the other two are why the row is read.
 */
function sessionLine(view: SessionView, state: SurfaceState, now: number): string {
  const glyph = `${GLYPHS[state]} `;
  const suffix = ` ${SEPARATOR} ${state} ${SEPARATOR} ${span(Math.max(now - view.lastHookAt, 0))}`;
  const room = MAX_BLOCK_WIDTH - [...glyph].length - [...suffix].length;
  const limit = Math.min(MAX_SESSION_NAME_LENGTH, Math.max(room, 0));
  return `${glyph}${inertBlockField(displayName(view), limit)}${suffix}`;
}

/**
 * The card's closing line: how old the card's information is, and the standing conditions that
 * change what the rest of it means.
 *
 * A held reading says so here first. Numbers redrawn from the last readable cache with nothing
 * marking them read as a cache that is still answering, and the age beside them is the only other
 * signal; the marker names the failure so the two are read together.
 *
 * The age is anchored to the oldest reading on the card rather than to the current time, and that is
 * load-bearing rather than incidental. This card is edited only when its text changes, so a footer
 * carrying a clock would rewrite the message on every refresh and spend an edit on a fleet where
 * nothing happened. Anchored to the data, it changes only as that reading ages, which is a slower
 * clock than the refresh but not a still one: the age is minute-granular below an hour, so the body
 * still moves once a minute until every reading and every session line has aged past that mark.
 *
 * The interim-mirroring note is here because the card cannot be read correctly without it: with the
 * transcript tailer off, threads carry no mid-turn narration and no open-question alerts, so quiet
 * threads beside a card full of working sessions are the configuration rather than the fleet.
 */
function footerLine(
  reading: UsageReading,
  interimMirror: boolean,
  unreadable: UsageUnavailableReason | null,
  now: number,
): string {
  const parts: string[] = [];
  if (unreadable !== null) {
    parts.push(`⚠ ${UNAVAILABLE[unreadable]}, so these are the last numbers it held`);
  }
  const measured = reading.available
    ? reading.accounts.map((account) => measuredAt(account, now)).filter((at) => at !== null)
    : [];
  if (measured.length > 0) {
    parts.push(`card as of ${heartbeat(Math.max(now - Math.min(...measured), 0))}`);
  }
  if (!interimMirror) {
    parts.push("interim mirroring off, so threads carry no narration or question alerts");
  }
  return parts.join(` ${SEPARATOR} `);
}

/** What a card that ran out of room ends with, naming what it left out rather than cutting silently. */
function overflowTail(accounts: number, sessions: number): string {
  const parts: string[] = [];
  if (accounts > 0) parts.push(`+${accounts} account${accounts === 1 ? "" : "s"}`);
  if (sessions > 0) parts.push(`+${sessions} session${sessions === 1 ? "" : "s"}`);
  return `(${parts.join(", ")} not shown)`;
}

/**
 * The whole card, bounded to one message.
 *
 * Composed by blocks rather than cut at the end, because the tail is where the session section
 * lives: a card assembled whole and then truncated would drop the live sessions off a busy host
 * silently, which is exactly the host whose sessions are worth reading. Room for the overflow tail
 * is reserved against every block, the last included, so the tail always fits when it is needed.
 *
 * Accounts come first and sessions second, and the overflow tail names what was dropped from
 * either, so a full fleet reads as a card that ran out of room rather than as a card that ends
 * mid-thought.
 *
 * The footer's room is taken out of the budget before the first block is measured, so it survives a
 * card that ran out of room: it carries the age of everything above it, which is worth more on a
 * crowded card than the last account that would otherwise have taken its place. The fence's own two
 * delimiter lines are reserved the same way and for the same reason.
 *
 * The heading is the one line outside the fence and everything else is inside it, because this is
 * one message carrying every account: a per-account heading in bold would die inside the block, and
 * the alignment the block provides is what replaces that emphasis. The whole body is measured in one
 * pass so every account's numbers stand in one column rather than in a column per account.
 *
 * Nothing here reads a clock or anything else the inputs do not carry, so two renders of the same
 * inputs compose the same bytes: the card is edited only when its text changes, and a body that
 * varied between renders would spend an edit a minute on a fleet where nothing happened.
 */
export function renderUsageCard(input: {
  reading: UsageReading;
  sessions: readonly SessionView[];
  thresholds: StateThresholds;
  /** Whether the transcript tailer is running, which is what the footer's coupling note reports. */
  interimMirror: boolean;
  /**
   * Set when the reading above is a held one: the cache could not be read for this card, and the
   * numbers on it are the last that could be. Absent means the reading is what the cache says now,
   * which includes an unavailable reading with nothing behind it to hold.
   */
  unreadable?: UsageUnavailableReason | null;
  now: number;
}): string {
  const footer = footerLine(input.reading, input.interimMirror, input.unreadable ?? null, input.now);
  const footerLines = wrapped(footer);
  const body: string[] = [];
  let used =
    HEADING.length + FENCE_COST + footerLines.reduce((sum, line) => sum + 1 + line.length, 0);
  const finish = (): string => {
    body.push(...footerLines);
    return `${HEADING}\n${fenced(body)}`;
  };

  // The state each session renders under comes from the one derivation the thread titles use, so a
  // session cannot read as working on the card and idle in the channel list. `exited` is what an
  // ended session derives, and those are omitted: the card is what is running now.
  const live = input.sessions
    .map((view) => ({ view, state: deriveSurfaceState(view, input.now, input.thresholds) }))
    .filter((entry) => entry.state !== "exited");

  // A reading that parsed but holds no accounts gets a reason of its own. It is a real state, not a
  // hypothetical one: a cache whose entries are all the wrong shape reads exactly this way, and a
  // heading with nothing under it tells the operator neither what is wrong nor that anything is.
  const blocks: BlockRow[][] = !input.reading.available
    ? [[{ label: null, value: `⚠ usage unavailable ${SEPARATOR} ${UNAVAILABLE[input.reading.reason]}` }]]
    : input.reading.accounts.length === 0
      ? [[{ label: null, value: NO_ACCOUNTS }]]
      : input.reading.accounts.map((account) => accountRows(account, input.now));

  // One column for the whole card, measured over every account's rows before any of them is drawn.
  // A width measured per account would step in and out as one account carries a per-model window
  // another does not, which is the misalignment down the card that the block exists to remove.
  const column = columnWidth(blocks.flat());

  for (const [index, block] of blocks.entries()) {
    const drawn = alignedRows(block, column);
    const cost = drawn.reduce((sum, line) => sum + 1 + line.length, 0);
    const tail = overflowTail(blocks.length - index, live.length);
    if (used + cost + 1 + tail.length > MAX_CARD_LENGTH) {
      body.push(...wrapped(tail));
      return finish();
    }
    body.push(...drawn);
    used += cost;
  }

  if (live.length === 0) return finish();

  const headingCost = 1 + SESSIONS_HEADING.length;
  if (used + headingCost + 1 + overflowTail(0, live.length).length > MAX_CARD_LENGTH) {
    body.push(...wrapped(overflowTail(0, live.length)));
    return finish();
  }
  body.push(SESSIONS_HEADING);
  used += headingCost;

  for (const [index, entry] of live.entries()) {
    const line = sessionLine(entry.view, entry.state, input.now);
    const tail = overflowTail(0, live.length - index);
    if (used + 1 + line.length + 1 + tail.length > MAX_CARD_LENGTH) {
      body.push(...wrapped(tail));
      return finish();
    }
    body.push(line);
    used += 1 + line.length;
  }
  return finish();
}
