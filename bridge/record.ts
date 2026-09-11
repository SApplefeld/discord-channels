// The record file: a plain-text, append-only transcript of one DSH conversation, kept beside the
// worker's own workspace. The Approach's whole point for this section: the record admits appends
// from the bridge alone, a party's turn and the worker's answer each land as one section, and
// `dsh_record_rotate` is the only way the file moves.
//
// A record is byte-identical to what either party wrote between its own header and its `NEXT:`
// line: the bridge never edits, summarizes, or escapes it, unlike the channel event and the tail
// line, which both read back to a model and so go through a neutralizer this file does not import.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { DEFAULT_COUNTERPARTY, DEFAULT_PARTY, MAX_META_REASON, MAX_PARTY_NAME, isHidden, isRecord, metaValue } from "./protocol.ts";
import type { TurnKind } from "./protocol.ts";
import { samePath } from "./harness.ts";

export { DEFAULT_COUNTERPARTY, DEFAULT_PARTY };

/**
 * `party` or `counterparty` as `dsh_prompt` admits it: trimmed, non-blank, at most
 * {@link MAX_PARTY_NAME} code points, and free of the hidden class and a line break, since the value
 * becomes the whole of one word on a section header line {@link formatSection} writes to the record.
 *
 * The guard lives here rather than in the dispatch that calls it, because this file is the boundary
 * that actually interpolates a caller-chosen `party` or `counterparty` into the record: a second
 * caller of `formatSection` imports this rather than re-spelling the same shape check.
 */
export function partyName(value: string): string | undefined {
  const trimmed = value.trim();
  const points = [...trimmed];
  if (trimmed === "" || points.length > MAX_PARTY_NAME || /[\r\n]/.test(trimmed)) return undefined;
  return points.some((point) => isHidden(point.codePointAt(0) ?? 0)) ? undefined : trimmed;
}

/**
 * The most turns this writer holds pending at once, across every session name.
 *
 * A turn enters when its prompt registers it and leaves once both sections have reached the file,
 * were dropped for an append failure, or the prompt was discarded. Bounded so a caller that never
 * lets a turn finish is a map with something to remove it, exactly as `MAX_PENDING_RECEIPTS` bounds
 * the same shape of collection in `harness.ts`.
 */
export const MAX_PENDING_TURNS = 64;

/**
 * One section as it is appended to the record: a header naming who spoke and when, the text exactly
 * as it arrived, and the line naming who speaks next.
 *
 * Exported on its own so the format is tested apart from the filesystem. Only the header and the
 * `NEXT:` line are this writer's own words; `text` rides through unedited, per the single-writer
 * rule the Approach states for this file. `annotation`, when given, rides in the header only, as
 * `(annotation)` after the timestamp: a killed or lost turn's kind and finish reason belong to the
 * bridge's own account of what happened, never to the body the byte-identical acceptance bullet
 * pins to what either party actually wrote.
 *
 * `speaker` names `party` or `counterparty`, never the session: two session names sharing one record
 * file (`protocol.ts` permits it) tell their sections apart only by whatever `party` and
 * `counterparty` a caller chose for each, which is not the session name unless a caller made it so.
 * A reader of a record two sessions share who wants to know which session a section belongs to needs
 * distinct `party`/`counterparty` values per session on that file; the format itself carries nothing
 * else to tell them apart.
 */
export function formatSection(speaker: string, next: string, text: string, iso: string, annotation?: string): string {
  const suffix = annotation === undefined ? "" : ` (${annotation})`;
  return `## ${speaker} @ ${iso}${suffix}\n${text}\nNEXT: ${next}\n`;
}

/**
 * The bytes of `content` that come before its first section: everything before the first line
 * beginning `## `, or the whole of `content` when it has no such line.
 *
 * What `dsh_record_rotate` carries into the fresh file. An ordinary bridge-written record has none
 * of this, since its very first byte is a section's own header; what this preserves is text an
 * operator put at the top of the file by hand, which the single-writer rule exempts.
 */
export function leadingHeader(content: string): string {
  const match = /^## /m.exec(content);
  return match === null ? content : content.slice(0, match.index);
}

/** One record's content as it is on disk now, or the empty string for a file that is not there yet. */
function readRecord(recordPath: string): string {
  try {
    return readFileSync(recordPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Append one already-formatted section to the record at `recordPath`, creating the file and its
 * parent directory when neither is there.
 *
 * One open file descriptor for the whole call, read and written through, and never a
 * read-modify-write of the file's own bytes: the file can run to megabytes over a long conversation,
 * since a section carries a worker's answer in full, uncapped, and it is read by a person rather than
 * rewritten by this bridge past its own end. A blank line separates this section from whatever the
 * file already held, so two sections never run together into what reads as one paragraph; the very
 * first bytes of a fresh file carry no such line, which is also why an ordinary bridge-written
 * record's leading header is empty. The size this reads and the bytes this appends are the one
 * descriptor's own view, so nothing between an `existsSync`, a `statSync` and a separate
 * `appendFileSync` call can change the file's shape out from under the decision those three would
 * otherwise make across separate syscalls.
 */
function appendSection(recordPath: string, section: string): void {
  // A conversation record can carry whatever either party wrote, so the directory and the file this
  // call creates are owner-only: `mode` applies only at creation, so an existing file or directory
  // an operator already made more permissive is left exactly as they set it.
  mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  const fd = openSync(recordPath, "a", 0o600);
  try {
    const before = fstatSync(fd).size;
    writeSync(fd, before > 0 ? `\n${section}` : section, null, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The identity of one registered turn, opaque to every caller but this writer.
 *
 * `registerTurn` mints one and every later call names the turn by it rather than by the session
 * name a second, overlapping registration for that same name could otherwise be mistaken for.
 */
export type TurnToken = symbol;

/**
 * One record's turn as this writer holds it between the moment a prompt registers it and the moment
 * both of its sections have reached the file.
 */
interface PendingTurn {
  readonly session: string;
  readonly recordPath: string;
  readonly party: string;
  readonly counterparty: string;
  /**
   * The party's own timestamp, taken when the turn is registered rather than when its section is
   * actually appended. The two moments can be seconds apart, since `appendParty` runs only once the
   * runtime has accepted the prompt. What this guarantees is per-session: this turn's own party
   * timestamp is always earlier than its own counterparty's, since the counterparty section is never
   * formatted before the party's registration. It is not a guarantee across two names that share one
   * record file (`protocol.ts` lets a caller point two sessions at the same `record`): a slower
   * session registered first can still have its party section physically appended after a faster
   * session's, registered later, so the file's byte order and its printed timestamps can disagree for
   * two different names on one file even though neither turn's own two sections ever do.
   */
  readonly partyIso: string;
  partyWritten: boolean;
  /**
   * The counterparty's section, formatted and held here when the turn's end reached this writer
   * before the party's section did. Formatted at the moment it arrives, so the timestamp it carries
   * is when the turn actually ended rather than whenever the party's section happens to flush it.
   */
  queuedCounterparty?: string;
}

/**
 * The bridge's one writer of the record file, holding what one turn needs to append its two sections
 * in the order the plan requires.
 *
 * `dsh_prompt`'s handler and the turn-end handler call this from two different places in the
 * dispatch, and the turn-end handler can run before the prompt handler has returned its own receipt:
 * `Bridge`'s `onTurnEnd` contract says a runtime that answers and finishes a turn before the prompt
 * request comes back runs its listener from inside that still-pending call. So a counterparty
 * section can be asked for before the party section that must precede it in the file has been
 * appended, and this class holds it until it has, rather than writing out of order.
 *
 * Keyed on a token rather than on the session name, because the name alone is not the turn: a second
 * `dsh_prompt` for a name that already has a turn pending is exactly the shape the bridge's own
 * "has a turn in flight" refusal is built to catch, and it is caught only after this writer would
 * already have registered the second turn, since registration happens before the request that
 * refusal comes from is even sent. A name-keyed map has nothing to tell the two turns apart and the
 * second registration silently destroys the first's still-pending entry; `active` maps a session
 * name to the one token currently registered for it, `registerTurn` refuses to mint a second token
 * while one is active, and every other method is handed the token a `registerTurn` call actually
 * returned rather than the name.
 */
export class RecordWriter {
  private readonly pending = new Map<TurnToken, PendingTurn>();
  private readonly active = new Map<string, TurnToken>();
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => undefined) {
    this.log = log;
  }

  /**
   * Register the record this session's next turn writes to, before the prompt that starts it is
   * sent, and return the token every later call for this turn is made with. Returns undefined, and
   * registers nothing, for a turn that writes no record (`recordPath` is undefined), for a name that
   * already has a turn registered (refused rather than replacing it, since the existing one may
   * still be mid-flight), and once {@link MAX_PENDING_TURNS} turns are already held.
   */
  registerTurn(session: string, recordPath: string | undefined, party: string, counterparty: string, now: () => string): TurnToken | undefined {
    if (recordPath === undefined || this.active.has(session)) return undefined;
    if (this.pending.size >= MAX_PENDING_TURNS) {
      this.log(`dsh-bridge: no more than ${String(MAX_PENDING_TURNS)} record turns are held at once, so this one writes nothing to its record`);
      return undefined;
    }
    const token: TurnToken = Symbol(session);
    this.pending.set(token, { session, recordPath, party, counterparty, partyIso: now(), partyWritten: false });
    this.active.set(session, token);
    return token;
  }

  /** Drop everything this writer holds for `token`, wherever the turn is not there at all. */
  private drop(token: TurnToken): void {
    const turn = this.pending.get(token);
    if (turn === undefined) return;
    this.pending.delete(token);
    if (this.active.get(turn.session) === token) this.active.delete(turn.session);
  }

  /** Drop a registered turn whose prompt was refused or rejected, so nothing is appended for it. */
  discardTurn(token: TurnToken | undefined): void {
    if (token !== undefined) this.drop(token);
  }

  /**
   * Append the party's section, once the runtime has accepted the prompt and before its receipt
   * returns. Flushes a counterparty section already queued for this same turn right after it, since
   * that is the moment the ordering it was held for is satisfied. A no-op for a turn nothing was
   * registered for (no record was in effect). On a failed append, whether the party's own or a
   * flushed counterparty's, this turn is dropped rather than left to leak a queued answer nothing
   * will ever flush, and the failure is rethrown to the caller: tagged `partyAppended: true` when the
   * party section is the one that landed and only the flushed counterparty failed, so a caller does
   * not report "nothing was appended" about a turn half of which is already on disk.
   */
  appendParty(token: TurnToken | undefined, text: string): void {
    if (token === undefined) return;
    const turn = this.pending.get(token);
    if (turn === undefined) return;
    try {
      appendSection(turn.recordPath, formatSection(turn.party, turn.counterparty, text, turn.partyIso));
    } catch (error) {
      this.drop(token);
      throw error;
    }
    turn.partyWritten = true;
    if (turn.queuedCounterparty === undefined) return;
    try {
      appendSection(turn.recordPath, turn.queuedCounterparty);
    } catch (error) {
      this.drop(token);
      if (error instanceof Error) Object.assign(error, { partyAppended: true });
      throw error;
    }
    this.drop(token);
  }

  /**
   * Append the counterparty's section at a turn's end, or hold it when this same turn's party
   * section has not reached the file yet. A no-op for a turn nothing was registered for. On a
   * failed append this turn is dropped rather than left registered with nothing left to flush it,
   * and the failure is rethrown to the caller.
   *
   * `accepted` false means the runtime never answered the prompt this turn was registered for, so
   * nothing was ever promised a turn: the registration is dropped and nothing is appended, rather
   * than writing a counterparty section for a party section that will never exist. `kind` other than
   * `"turn_end"` (a kill or a runtime loss) is named in the section's own header, as `(kind:
   * finishReason)`, never in the body: the body stays byte-identical to what the runtime actually
   * said, empty or not, and a person reading the file is the one told this section closed a turn
   * that did not run to completion. `finishReason` is the runtime's own word and rides in the header
   * rather than the body, so unlike the body it is bounded and neutralized through `metaValue`, the
   * same guard the channel event's own `finish_reason` field takes: a section header is not the
   * verbatim body the byte-identical acceptance bullet pins, and an unbounded, unneutralized value
   * there could forge a section of its own.
   */
  noteTurnEnd(session: string, text: string, now: () => string, kind: TurnKind, finishReason: string, accepted: boolean): void {
    const token = this.active.get(session);
    if (token === undefined) return;
    if (!accepted) {
      this.drop(token);
      return;
    }
    const turn = this.pending.get(token);
    if (turn === undefined) return;
    const annotation = kind === "turn_end" ? undefined : `${kind}: ${metaValue(finishReason, MAX_META_REASON)}`;
    const section = formatSection(turn.counterparty, turn.party, text, now(), annotation);
    if (!turn.partyWritten) {
      turn.queuedCounterparty = section;
      return;
    }
    try {
      appendSection(turn.recordPath, section);
    } finally {
      this.drop(token);
    }
  }

  /**
   * Every session name this writer still holds a turn open for on `recordPath`, whether or not the
   * runtime that started it still shows one in flight.
   *
   * The one answer `dsh_record_rotate`'s in-flight refusal can trust: `Bridge`'s own busy list is
   * cleared before a turn's own end is delivered (`finish` removes the live entry, then pushes the
   * channel event, then calls `onTurnEnd`), and a counterparty section still queued here, waiting on
   * a party section a concurrent `dsh_prompt` has not appended yet, can outlive that clearing across
   * the `await` in that same prompt's own handler. A holder list built from busy sessions alone goes
   * empty in that window while this writer still has an unflushed section bound for the same file.
   */
  holdersOf(recordPath: string): string[] {
    const names: string[] = [];
    for (const turn of this.pending.values()) {
      if (samePath(turn.recordPath, recordPath)) names.push(turn.session);
    }
    return names;
  }
}

/**
 * `rotateRecord`'s error code for the one failure it reports specially: the rename to `archivePath`
 * already succeeded and starting a fresh file at `recordPath` then failed. A caller checks this
 * before falling back to a generic report, since the generic path would otherwise read `recordPath`
 * out of the raw error and put bridge bookkeeping the caller never named on this call in front of
 * the model.
 */
export const ROTATE_FRESH_FILE_FAILED_CODE = "ROTATE_FRESH_FILE_FAILED";

/**
 * Move the record at `recordPath` to `archivePath` and start a fresh one carrying the original's
 * leading header block. Returns whether a record existed to archive; false means nothing was there
 * and no rename ran, so the fresh file this call still creates is simply an empty one.
 *
 * A rename, never a copy and a delete, so the move is one atomic step. Refused, before anything is
 * touched, when `archivePath` names the same place as `recordPath` (a no-op rename followed by
 * truncating that same file to its header, destroying the whole record). When a record exists to
 * move, `archivePath` naming a file that already exists is refused too (silently replacing it,
 * whether that file is another session's live record, an earlier archive, or something outside this
 * bridge's business entirely), claimed and checked as one exclusive-create rather than a separate
 * check and a later rename, so nothing can be written to `archivePath` between the two. Neither
 * refusal is a shape `recordFilePath` refuses, since both are otherwise ordinary absolute paths to
 * files. What `recordPath`
 * names is otherwise the caller's choice, exactly as `recordFilePath` leaves it: there is no content
 * check here to tell an operator's own document from a record this bridge wrote, since the two are
 * indistinguishable in shape and a rotate is meant to run on a document the operator names for the
 * first time. The path this call and `appendSection` both refuse is the bridge's own state
 * directory, checked at every caller before either function is reached (`insideStateDirectory` in
 * `harness.ts`), because that is the one artifact whose corruption every bridge process on the
 * machine cannot survive.
 */
export function rotateRecord(recordPath: string, archivePath: string): boolean {
  if (samePath(archivePath, recordPath)) {
    throw new Error("archive_path names the record itself, so the rotate is refused rather than truncating it to its own header.");
  }
  const archived = existsSync(recordPath);
  const content = readRecord(recordPath);
  const header = leadingHeader(content);
  mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  if (archived) {
    mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
    // Claimed exclusively before the rename touches it, rather than an `existsSync` check followed
    // by a separate `renameSync`: `fs.renameSync` replaces an existing destination outright on every
    // platform this runs on, so a file created at `archivePath` between a check and a later rename,
    // by the unsandboxed worker or by a sibling bridge writing its own record, would be destroyed
    // silently. `wx` fails with `EEXIST` when the path is already taken, which is exactly the case
    // this refuses, and there is no gap between that failure and the claim that would let one in.
    let claim: number;
    try {
      claim = openSync(archivePath, "wx", 0o600);
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        throw new Error("archive_path already names a file that exists, so the rotate is refused rather than silently replacing it.");
      }
      throw error;
    }
    closeSync(claim);
    renameSync(recordPath, archivePath);
    try {
      writeFileSync(recordPath, header, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      // The rename already succeeded: the record is at `archivePath` now, not lost and not still at
      // `recordPath`, so a caller told only the raw failure would retry with the same archive_path
      // and be refused as already existing, or a new one and be told nothing was archived, both false.
      // `code` is set to a marker rather than left absent, so a caller narrowing this through
      // `faultCode` sees the marker instead of falling back to this message, which would otherwise
      // carry `recordPath`, bridge bookkeeping the caller did not name on this call, through to the
      // model untouched. `record` and `archive_path` are otherwise the only paths a rotate ever puts
      // in front of a caller, and only because the caller named them first.
      throw Object.assign(
        new Error("a fresh file could not be started at the record's own path after the rename to archive_path already succeeded"),
        { code: ROTATE_FRESH_FILE_FAILED_CODE },
      );
    }
    return true;
  }
  writeFileSync(recordPath, header, { encoding: "utf8", mode: 0o600 });
  return false;
}

