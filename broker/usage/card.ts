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
//
// Which escape depends on where the field lands, and the card has both kinds of place. A field
// drawn inside a fence takes `inertBlockField`, because a fence renders no markdown and resolves no
// chip, so the full escape would reach the operator as a backslash in front of every underscore a
// real name contains. The account label is drawn in the bold line above its fence, which is live
// markdown, so it takes `inertField`, the same neutralization the session status card's own title
// takes: there a crafted address could otherwise draw a mention pill, a heading of its own, or a
// fence delimiter, and an unescaped asterisk could close the emphasis it sits inside.
import {
  BAR_GLYPH,
  FENCE_COST,
  MAX_BLOCK_WIDTH,
  MAX_CARD_LENGTH,
  alignedRows,
  columnWidth,
  displayName,
  fenced,
  heartbeat,
  inertBlockField,
  inertField,
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

/**
 * The card's name where Discord draws a message's first line, inline beside the bot's own name.
 * That position reads as chrome rather than as the card's heading, which is why the title below
 * repeats it, and it is the line a channel list and a phone notification show.
 */
const PREVIEW = "📊 **Fleet: Usage**";

/**
 * The card's top edge, at the largest heading Discord draws, which is the rank the session status
 * card gives its own title. A channel of cards scrolls as one undifferentiated run of text
 * otherwise, with nothing to pick one card out of the run by. Drawn beneath `PREVIEW` and saying
 * the same thing, the way the status card draws its own name twice and for the same two reasons.
 */
const TITLE = "# 📊 Fleet: Usage";

/**
 * The label over one section's fenced block: bold paragraph text rather than a heading of any rank.
 *
 * Discord puts its own margin above a heading and around a fenced block, and at one section per
 * account that margin is paid three or four times down a card read on a phone, which is air the
 * card spends instead of numbers. `###` is the smallest heading Discord draws, so the only weight
 * left below it is no heading at all: bold paragraph text carries no margin of its own and still
 * reads as a boundary between one account and the next.
 *
 * Outside the fence either way, which is the only place Discord renders emphasis at all: inside one
 * it would reach the operator as the asterisks it is written with. The label sits directly against
 * the block it heads, with no blank line between them, because the block already brings its own air
 * and a blank line there is spacing on top of spacing.
 */
function sectionLabel(text: string): string {
  return `**${text}**`;
}
const SESSIONS_HEADER = sectionLabel("Sessions");
const NO_ACCOUNTS = `⚠ usage unavailable ${SEPARATOR} the usage cache holds no accounts`;

/**
 * How many cells the bar every row leads with is drawn in.
 *
 * A fixed area, so every column after it stands still whatever the value is, and fifteen cells wide
 * because that is what the block's width bound leaves once the label column, the percentage, a
 * reset clause and a marker have taken theirs. It is the row's whole reason for being wider: a
 * length is read at a glance, where a number has to be converted first.
 *
 * The count is this card's own geometry, unlike the glyph the cells are drawn in, which every card
 * that draws a bar shares.
 */
export const BAR_CELLS = 15;

/** What holds a row's clause off the percentage before it, and the percentage off the bar. */
const CLAUSE_GAP = "  ";

/**
 * What holds a row's marker off whatever it follows. One column rather than the clause's two: the
 * marker ends the line, where there is nothing after it for a wider gap to separate it from, and
 * the column it gives back is a column the bar spends.
 */
const MARKER_GAP = " ";

/**
 * The width every percentage is drawn in: the largest one that can be drawn, and the columns that
 * hold it off the bar to its left. Right-aligned inside that width, the digits stack under each
 * other whatever numbers a fleet happens to carry. Fixed rather than measured off the card, because
 * a column that narrowed when no account happened to be in three figures would move the whole
 * card's numbers as usage crossed 100%.
 */
export const PCT_WIDTH = CLAUSE_GAP.length + `${MAX_DRAWN_PCT}%`.length;

/**
 * The two markers a row can end with, and the key to them.
 *
 * ASCII rather than glyphs, because each then costs exactly the columns it occupies: an emoji is
 * wider than the one character a monospace grid counts it as, so one at the end of a row would push
 * that row past a width every other row is held to. They are not padded to a column of their own
 * either, so rows whose clauses are the same width align naturally and a row carrying no marker
 * carries no trailing whitespace.
 *
 * One marker per row, and the warning wins. A window at or past the threshold is almost always
 * ahead of pace as well, so a row that could carry either one marker or two would carry two on the
 * common case rather than the rare one, and a row whose end column moves is what the alignment
 * exists to prevent.
 */
const AHEAD_MARKER = "(^)";
const WARNING_MARKER = "(!)";
const LEGEND = `${AHEAD_MARKER} ahead of pace   ${WARNING_MARKER} at or above ${WARNING_PCT}%`;

/**
 * What the two fixed windows and the credit limit are called in the label column. Spelled for
 * reading rather than for width: the column is padded to the longest label the whole card carries,
 * and a per-model window names itself out of another program's cache at whatever length that
 * program wrote, so these are never what sizes it.
 */
const FIVE_HOUR_LABEL = "5 Hr";
const SEVEN_DAY_LABEL = "7 Day";
const SPEND_LABEL = "Spend";

/** What an account's label line says instead of an age when its fetch time cannot be believed. */
const UNKNOWN_AGE = "age unknown";

/** What a scoped row is called when the cache's name for it neutralizes to nothing. */
const UNNAMED_SCOPE = "per-model";

/** What an unavailable reading says, one static phrase per reason. */
const UNAVAILABLE: Record<UsageUnavailableReason, string> = {
  unreadable: "the usage cache cannot be read on this host",
  oversized: "the usage cache is larger than this reader will open",
  malformed: "the usage cache does not parse",
};

/**
 * `3h 44m` for a window that carries a reset time, and nothing at all for one that does not, which
 * is the shape claude-swap really writes for some accounts and which draws as a percentage that
 * simply stops. A reset instant already behind the current time renders as due rather than as a
 * countdown running backwards: the cache can be older than the window it describes.
 *
 * The span alone, with no word in front of it. The bar beside it is what says how far through the
 * window the account is, so a word introducing the countdown spends columns restating what the row
 * already shows, and those columns are what the bar is drawn in.
 */
function resetsClause(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return "";
  const remaining = window.resetsAt - now;
  return remaining <= 0 ? "due" : span(remaining);
}

/**
 * The bar for a percentage: filled left to right, one cell per 100/15 of a point, rounded to
 * nearest, and blank-padded to the full width so the columns after it never move.
 *
 * It reads two percentages, and which one governs what is the whole rule. The cells are counted off
 * the percentage as the card draws it, so the length and the digits beside it can never disagree
 * about the same window. The floor of one cell is read off the raw percentage instead: any usage at
 * all draws a cell, including the trace that rounds to `0%`. A window at 0.4% drawing one cell
 * beside a `0%` is the intended signal rather than a contradiction, because a bar identical to
 * zero's is the one thing that leaves a trace and a true zero indistinguishable, and telling those
 * two apart is why the bar is on the card. Zero and anything below it draw no cell at all.
 */
function bar(drawn: number, raw: number): string {
  const scaled = Math.round((drawn * BAR_CELLS) / 100);
  const cells = raw <= 0 ? 0 : Math.min(Math.max(scaled, 1), BAR_CELLS);
  return `${BAR_GLYPH.repeat(cells)}${" ".repeat(BAR_CELLS - cells)}`;
}

/**
 * One row's value: the bar, the percentage right-aligned so the digits stack, then the clause that
 * says when the window resets or what the spend is, then the marker. The drawn percentage is what
 * the row shows and what its bar is measured in; the raw one rides along for the bar's floor alone.
 *
 * The bar and the percentage are always drawn, and each of the two after them appears only when it
 * carries something. Leaving an empty part out rather than padding past it is what keeps a row that
 * has nothing to say after its percentage from carrying trailing whitespace.
 *
 * The value leads with a space of its own. The aligning machinery puts one space between the label
 * column and the value it draws, and every other part of the row is held off its neighbor by two,
 * so the second space here is what makes the label-to-bar gap read like the rest of the row.
 */
function rowValue(drawn: number, raw: number, clause: string, marker: string): string {
  const measure = ` ${bar(drawn, raw)}${`${drawn}%`.padStart(PCT_WIDTH)}`;
  const said = clause === "" ? "" : `${CLAUSE_GAP}${clause}`;
  return `${measure}${said}${marker === "" ? "" : `${MARKER_GAP}${marker}`}`;
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
 * Which marker a percentage earns: the warning at or past the threshold, the pace marker below it,
 * and nothing at all otherwise.
 *
 * The threshold is read off the percentage as it renders rather than off the raw one, so two rows
 * drawn as `90%` are never marked differently: a threshold read off a number the operator cannot
 * see is a card that looks inconsistent with itself.
 */
function rowMarker(pct: number, ahead: boolean): string {
  if (pct >= WARNING_PCT) return WARNING_MARKER;
  return ahead ? AHEAD_MARKER : "";
}

/**
 * Whether a line, as the block will actually show it, ends in a marker.
 *
 * The legend is keyed off this rather than off the markers the rows were composed with, because a
 * value too wide for the block is cut to fit and the marker is the part at the end that goes: a key
 * to a symbol nowhere on the card is a puzzle rather than a legend. It is read together with the
 * section's own flag, never on its own, since the cache names a per-model window and a currency and
 * a field that happens to read as a marker is not one.
 */
function endsMarked(line: string): boolean {
  return line.endsWith(WARNING_MARKER) || line.endsWith(AHEAD_MARKER);
}

/**
 * What an account is called: its address, its organization name, or its slot number. The slot
 * number is the one part that is this broker's own, so it is what the label falls back to when
 * `sequence.json` was unreadable or when the identity it held neutralizes to nothing.
 *
 * Neutralized for live markdown rather than for a fenced line, because the bold line it is drawn in
 * is a surface Discord resolves a mention, an emoji chip, a heading, and a fence delimiter on, and
 * where an unescaped asterisk would close the emphasis the label sits inside. Bounded by the field
 * cap alone: the width bound is a property of a fenced line, where a phone scrolls sideways instead
 * of wrapping, and a paragraph line is neither cut nor scrolled.
 */
function accountLabel(account: UsageAccount): string {
  const named = inertField(account.email ?? account.organizationName ?? "", MAX_ACCOUNT_LABEL_LENGTH);
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

/** The amount from which cents stop being drawn, in cents: one thousand of the currency's unit. */
const WHOLE_UNITS_FROM = 100_000;

/**
 * The one money amount the card draws, which is what an account has spent: the integer part grouped
 * in threes, and the cents, so 95.4 draws as `95.40`. The cache's numbers arrive as JSON doubles, so
 * a sum of fractional charges reaches this renderer as `0.30000000000000004`, and rounding to the
 * cent is what a currency amount means. A trailing `.00` is dropped, since two zeros say only that
 * the amount is round.
 *
 * From a thousand up the cents are dropped entirely, so 13,440.50 draws as `13,440`. The row has to
 * stand inside the block's width beside a bar of fifteen cells, and three characters of cents on a
 * five-figure amount is what pushes it past that, where the line is cut and takes the row's marker
 * off the end with it. Cents on a large balance are also the digits least worth the columns: what
 * the operator reads a four-figure spend for is the scale of it.
 *
 * Formatted by hand rather than through `toLocaleString`, because the rendered body must depend on
 * nothing but the inputs: the card's byte-compare change detection rests on identical inputs
 * producing identical bytes, and a locale that groups with periods or swaps the decimal separator
 * would also silently change what the operator reads.
 */
function amount(value: number): string {
  const cents = Math.round(value * 100);
  const sign = cents < 0 ? "-" : "";
  // The magnitude decides, so a large negative amount drops its cents the way its positive twin
  // does rather than keeping them on the strength of its sign.
  const magnitude = Math.abs(cents);
  const whole = String(Math.trunc(magnitude / 100)).replace(/\B(?=(\d{3})+$)/g, ",");
  const fraction = magnitude >= WHOLE_UNITS_FROM ? 0 : magnitude % 100;
  return `${sign}${whole}${fraction === 0 ? "" : `.${String(fraction).padStart(2, "0")}`}`;
}

/**
 * One section of the card: the header drawn outside its fence, the rows drawn inside it, and
 * whether any of those rows earned a marker, which is half of what decides the legend at the foot.
 * The other half is whether a drawn line still ends in one, which only the composed block knows.
 *
 * A section with no header is one the card has no name for, which is the pair of readings that
 * carry a notice instead of an account: a header over a one-line apology says nothing the line does
 * not already say.
 */
type CardSection = { header: string | null; rows: BlockRow[]; marked: boolean };

/**
 * One account's section: a bold line carrying the active marker, the label, and the age, over a
 * block holding a row per window.
 *
 * The label is outside the fence, which is what gives each account a visible boundary rather than
 * leaving three accounts to run together as twelve near-identical lines. It also takes the width
 * pressure off the label: Discord wraps a paragraph line rather than scrolling it, so a long
 * address there cannot push a column, force a horizontal scroll, or disturb the alignment inside
 * the block.
 */
function accountSection(account: UsageAccount, now: number): CardSection {
  const fetchedAt = measuredAt(account, now);
  const age = fetchedAt === null ? UNKNOWN_AGE : heartbeat(Math.max(now - fetchedAt, 0));
  const active = account.active ? "▶" : SEPARATOR;
  const header = sectionLabel(`${active} ${accountLabel(account)} ${SEPARATOR} ${age}`);
  const rows: BlockRow[] = [];
  let marked = false;
  const windowRow = (label: string, window: UsageWindow, ahead: boolean): void => {
    const pct = drawnPct(window.pct);
    const marker = rowMarker(pct, ahead);
    if (marker !== "") marked = true;
    rows.push({ label, value: rowValue(pct, window.pct, resetsClause(window, now), marker) });
  };
  // The spend row leads the block, in the operator's own reading order: the credit balance is the
  // number the card is opened for, and the windows follow it.
  if (account.spend !== null) {
    const symbol =
      account.spend.currency === null ? null : (CURRENCY_SYMBOLS.get(account.spend.currency) ?? null);
    // What was spent, whenever the cache carries it, and the limit not at all: the percentage says
    // how much of the budget is gone and the bar says it again at a glance, so a ceiling drawn
    // beside them is a third telling of one fact, in columns the bar is drawn in instead. A known
    // currency's symbol leads the amount; an unknown code trails it instead.
    const amounts =
      account.spend.used === null ? "" : `${symbol ?? ""}${amount(account.spend.used)}`;
    const currency =
      account.spend.currency === null || symbol !== null || amounts === ""
        ? ""
        : ` ${inertBlockField(account.spend.currency, MAX_CURRENCY_LENGTH)}`;
    // The same threshold and the same rounding the window rows use: a credit limit is a limit, and
    // an operator scanning for what is close to running out reads one marker, not two rules. Pace
    // has no meaning here, so the spend row can only ever earn the warning.
    const pct = drawnPct(account.spend.pct);
    const marker = rowMarker(pct, false);
    if (marker !== "") marked = true;
    rows.push({
      label: SPEND_LABEL,
      value: rowValue(pct, account.spend.pct, `${amounts}${currency}`, marker),
    });
  }
  // The 5h window carries no pace marker at any percentage, and no roll either: it resets too fast
  // for a pace reading to mean anything, and its cadence is not the weekly one the roll advances by.
  if (account.fiveHour !== null) windowRow(FIVE_HOUR_LABEL, account.fiveHour, false);
  if (account.sevenDay !== null) {
    const seven = rolledWeekly(account.sevenDay, fetchedAt, now);
    windowRow(SEVEN_DAY_LABEL, seven, aheadOfPace(seven, fetchedAt));
  }
  for (const row of account.scoped) {
    const scoped = { ...row, ...rolledWeekly(row, fetchedAt, now) };
    // A maxed per-model limit carries the warning marker alone. Being ahead of pace is a forecast,
    // and it says nothing beside a window that has already arrived where the forecast pointed.
    const ahead = scoped.pct < 100 && aheadOfPace(scoped, fetchedAt);
    const name = inertBlockField(scoped.name, MAX_SCOPED_NAME_LENGTH);
    windowRow(name === "" ? UNNAMED_SCOPE : name, scoped, ahead);
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
  return { header, rows, marked };
}

/**
 * One live session: the name, the state, and how long since it last reported.
 *
 * A whole-width line, with the name cut to what the rest of it leaves: a session's name is the
 * field this broker does not size, and the other two are why the row is read. The state is the
 * word alone, with no glyph in front of it; the glyph vocabulary belongs to the thread titles,
 * where it survives the mobile list's truncation, and inside a block it costs width the name needs
 * while saying what the word beside it already says.
 */
function sessionLine(view: SessionView, state: SurfaceState, now: number): string {
  const suffix = ` ${SEPARATOR} ${state} ${SEPARATOR} ${span(Math.max(now - view.lastHookAt, 0))}`;
  const room = MAX_BLOCK_WIDTH - [...suffix].length;
  const limit = Math.min(MAX_SESSION_NAME_LENGTH, Math.max(room, 0));
  return `${inertBlockField(displayName(view), limit)}${suffix}`;
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
 * The whole card, bounded to one message: a title heading, a label-and-fence pair per account, one
 * more pair for the live sessions, then the marker legend and the footer as plain lines.
 *
 * The labels sit outside their fences and the rows inside them, which is the split the two halves
 * need. Bold is the heaviest text Discord draws that brings no margin with it, and that weight is
 * what gives each account a visible boundary; a fenced block is the only shape Discord gives that
 * keeps a column of numbers under each other. A section with nothing to show is left out, label and
 * block together, rather than drawn empty.
 *
 * Composed section by section rather than cut at the end, because the tail is where the sessions
 * live: a card assembled whole and then truncated would drop the live sessions off a busy host
 * silently, which is exactly the host whose sessions are worth reading. Accounts come first and
 * sessions second, and the overflow tail names what was dropped from either, so a full fleet reads
 * as a card that ran out of room rather than as one that ends mid-thought. The tail's room is
 * reserved against every section, the last included.
 *
 * The title, the legend and the footer are taken out of the budget before the first section is
 * measured, so all three survive a card that ran out of room: the footer carries the age of
 * everything above it and the legend is the key to markers that are already drawn, both of which are
 * worth more on a crowded card than the last account that would otherwise have taken their place.
 * Each fence's own two delimiter lines and each header's line are reserved the same way. The
 * legend's room is reserved whether or not it will be drawn, because whether a marker lands on the
 * card depends on which sections fit, which depends on the budget: reserving it conditionally would
 * be circular, and the cost of reserving it always is at most one unused line on a card that fills
 * to the brim.
 *
 * The label column is measured across every account's rows in one pass, so every account's numbers
 * stand in one column across the whole card rather than in a column per block, which is the property
 * that lets two accounts be compared by eye.
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
  const lines: string[] = [PREVIEW, TITLE];
  let marked = false;
  let used =
    PREVIEW.length +
    1 +
    TITLE.length +
    1 +
    LEGEND.length +
    footerLines.reduce((sum, line) => sum + 1 + line.length, 0);
  const finish = (): string => {
    if (marked) lines.push(LEGEND);
    lines.push(...footerLines);
    return lines.join("\n");
  };

  // The state each session renders under comes from the one derivation the thread titles use, which
  // reads both working and idle as active, so the card is where the two are told apart. `exited` is
  // what an ended session derives, and those are omitted: the card is what is running now.
  const live = input.sessions
    .map((view) => ({ view, state: deriveSurfaceState(view, input.now, input.thresholds) }))
    .filter((entry) => entry.state !== "exited");

  // A reading that parsed but holds no accounts gets a reason of its own. It is a real state, not a
  // hypothetical one: a cache whose entries are all the wrong shape reads exactly this way, and a
  // card that drew nothing at all tells the operator neither what is wrong nor that anything is.
  const sections: CardSection[] = !input.reading.available
    ? [notice(`⚠ usage unavailable ${SEPARATOR} ${UNAVAILABLE[input.reading.reason]}`)]
    : input.reading.accounts.length === 0
      ? [notice(NO_ACCOUNTS)]
      : input.reading.accounts.map((account) => accountSection(account, input.now));

  // One column for the whole card, measured over every account's rows before any of them is drawn.
  // A width measured per account would step in and out as one account carries a per-model window
  // another does not, which is the misalignment down the card that the blocks exist to remove.
  const column = columnWidth(sections.flatMap((section) => section.rows));

  for (const [index, section] of sections.entries()) {
    const drawn = alignedRows(section.rows, column);
    const cost =
      (section.header === null ? 0 : 1 + section.header.length) +
      FENCE_COST +
      drawn.reduce((sum, line) => sum + 1 + line.length, 0);
    const tail = overflowTail(sections.length - index, live.length);
    if (used + cost + 1 + tail.length > MAX_CARD_LENGTH) {
      lines.push(...wrapped(tail));
      return finish();
    }
    if (section.header !== null) lines.push(section.header);
    lines.push(fenced(drawn));
    used += cost;
    marked = marked || (section.marked && drawn.some(endsMarked));
  }

  const opening = live[0];
  if (opening === undefined) return finish();

  // The sessions header and its fence are spent together with the first session row, because none of
  // the three is worth drawing without the others: a header over an empty block, or a fence with
  // nothing between its delimiters, is what a budget spent line by line would leave behind.
  const first = sessionLine(opening.view, opening.state, input.now);
  const sectionCost = 1 + SESSIONS_HEADER.length + FENCE_COST + 1 + first.length;
  if (used + sectionCost + 1 + overflowTail(0, live.length).length > MAX_CARD_LENGTH) {
    lines.push(...wrapped(overflowTail(0, live.length)));
    return finish();
  }
  used += 1 + SESSIONS_HEADER.length + FENCE_COST;

  const shown: string[] = [];
  let cut: string | null = null;
  for (const [index, entry] of live.entries()) {
    const line = sessionLine(entry.view, entry.state, input.now);
    const tail = overflowTail(0, live.length - index);
    if (used + 1 + line.length + 1 + tail.length > MAX_CARD_LENGTH) {
      cut = tail;
      break;
    }
    shown.push(line);
    used += 1 + line.length;
  }
  lines.push(SESSIONS_HEADER, fenced(shown));
  if (cut !== null) lines.push(...wrapped(cut));
  return finish();
}

/**
 * A section carrying one line the card has no label for: the two readings that report why there
 * are no numbers rather than drawing any. Fenced like every other block so it is held to the same
 * width, and headerless because a header over a one-line notice says nothing the line does not.
 */
function notice(line: string): CardSection {
  return { header: null, rows: [{ label: null, value: line }], marked: false };
}
