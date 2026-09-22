// The fleet roster reader: which worker personas the board card draws a queue group for, taken from
// an operator-maintained JSON file and from nothing else.
//
// The roster is a plain array the operator edits by hand or through a script, written whole with no
// rename and no lock, the same way the persona plugin's own store is. A read can land mid-save, so a
// file that fails to read or fails to parse this tick keeps whatever the last good tick returned
// rather than going blank: a roster caught between two writes is not a roster with no personas in it.
//
// An entry's `workdir` becomes a read path once the queue reader opens files under it, so it is
// held to the same rule a configured project root is, narrowed further: it must name one fixed
// local directory, absolute and not drive-relative, whatever the process's own launch state was,
// and never a UNC share, which the roster's lower trust class refuses even though a configured root
// may name one. An entry failing that check, or any other check below, is silently absent from the
// result; only the whole file failing to read or parse is worth a return of the held reading,
// because one bad entry among good ones is the operator's own typo and not a sign the file is
// mid-write. A file that reads
// and parses to something other than an array is the one exception: a torn write of a JSON array
// cannot land as valid non-array JSON, so a well-formed non-array file is an operator typo too, and
// it yields no personas rather than the held reading.
import { readCappedFile } from "../capped-read.ts";
import type { CappedRead } from "../capped-read.ts";
import { namesOneLocalDirectory } from "../config.ts";

/** Ceiling on the roster file. Generous for a fleet the operator names by hand: the largest ordinary
 * roster runs to a few dozen entries of short strings each, so this is headroom against a file that
 * has grown a problem rather than a bound anyone should expect to approach. */
export const MAX_ROSTER_FILE_BYTES = 64 * 1024;

/** The most personas one roster contributes, by file order. A card drawing more groups than this is
 * not a card an operator watching from a phone can read, and the fleets this reads from today run to
 * a handful of workers. */
export const MAX_ROSTER_PERSONAS = 16;

/** Ceiling on a persona's `name`, in the register of `MAX_INTAKE_STATUS_LENGTH` in `plans.ts`: a
 * value held across every tick and drawn into the card's message budget must not be free to grow
 * without bound. The card's group label cuts a persona's name at 60 characters for display, so this
 * is sized modestly above that, generous for any name an operator would actually type, without
 * holding a pathologically long string in memory between ticks for a display that would cut it down
 * anyway. */
export const MAX_ROSTER_PERSONA_NAME_LENGTH = 100;

/** One enabled persona from the roster: its name for the card's label, and its working folder, which
 * the queue reader reads the persona plugin's store and heartbeat under. */
export type RosterPersona = {
  readonly name: string;
  readonly workdir: string;
};

export type RosterReaderOptions = {
  /** Injected so a test can pin what this module logs. Never carries a `workdir`: a roster entry's
   * working folder typically embeds the operator's OS username, and this reaches the log file. */
  log?: (message: string) => void;
};

export type RosterReader = {
  /** The enabled personas as of the most recent reading that both read and parsed to a JSON array,
   * in file order. A reading that read and parsed to something other than an array yields no
   * personas rather than the personas an earlier tick held. */
  read: () => readonly RosterPersona[];
};

/**
 * One capped read of the roster file, through the shared reader in `broker/capped-read.ts`, on the
 * same terms `readPlanFile` in `plans.ts` reads a plan doc: refused whole past the cap rather than
 * truncated, because a recognizer running on a cut copy can manufacture a match the full text never
 * held, and any failure at any stage is reported "unreadable" without inspecting why, since the
 * caller does the same thing either way.
 */
function readRosterFile(file: string): CappedRead {
  return readCappedFile(file, MAX_ROSTER_FILE_BYTES);
}

/**
 * One roster entry's persona, or null when the entry does not name one.
 *
 * `enabled` is read as a JSON boolean and nothing else: the persona plugin's own task registration
 * requires exactly `true`, so a truthy string or number here would count a persona the plugin itself
 * would not run. `name` is trimmed before the non-empty check, so a whitespace-only value refuses
 * rather than drawing a blank group heading that matches no persona-plugin store key, and it is held
 * to `MAX_ROSTER_PERSONA_NAME_LENGTH` for the same reason a plan doc's own free-form fields are
 * capped in `plans.ts`. `workdir` is read as a plain string; a value that is not absolute, or that
 * names a UNC share, is refused here rather than downstream, because downstream is where it becomes
 * a path to open.
 */
function entryPersona(entry: unknown): RosterPersona | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (record.enabled !== true) return null;
  const rawName = record.name;
  if (typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (name.length === 0 || name.length > MAX_ROSTER_PERSONA_NAME_LENGTH) return null;
  const workdir = record.workdir;
  if (typeof workdir !== "string" || !namesOneLocalDirectory(workdir)) return null;
  return { name, workdir };
}

/** The four ways a tick's reading can fail to update the held personas, or null on a tick that read
 * and parsed to an array. Never carries the file's text or path: only the class of failure is
 * logged, because the path and any `workdir` it would sit beside typically embed the operator's OS
 * account name. */
type RosterFailureClass = "unreadable" | "oversized" | "unparseable" | "not an array" | null;

/**
 * A reader over one roster file, holding the last reading that both read and parsed so a torn write
 * never blanks the card. A non-array file is the one exception: it clears rather than holds, since a
 * torn write of a JSON array cannot land as valid non-array JSON, so a well-formed non-array file is
 * an operator typo rather than a write in progress.
 *
 * The dropped-persona count and a read or parse failure are each logged once per change rather than
 * every tick: a fleet sitting one name past the cap, or a broker pointed at a roster that never
 * parses, would otherwise write that line on every refresh for as long as the broker runs.
 */
export function createRosterReader(path: string, options: RosterReaderOptions = {}): RosterReader {
  const log = options.log ?? ((): void => {});
  let held: readonly RosterPersona[] = [];
  let loggedDropped = 0;
  let loggedFailure: RosterFailureClass = null;

  const noteFailure = (cls: RosterFailureClass, keepsHeld: boolean): void => {
    if (cls === loggedFailure) return;
    if (cls !== null) {
      log(
        `fleet roster: ${cls}, ` +
          (keepsHeld ? "keeping the last good reading" : "no personas read this tick"),
      );
    }
    loggedFailure = cls;
  };

  return {
    read: () => {
      const file = readRosterFile(path);
      if ("failed" in file) {
        noteFailure(file.failed, true);
        return held;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(file.text);
      } catch {
        noteFailure("unparseable", true);
        return held;
      }
      if (!Array.isArray(parsed)) {
        noteFailure("not an array", false);
        held = [];
        return held;
      }
      noteFailure(null, false);

      const seen = new Set<string>();
      const candidates: RosterPersona[] = [];
      for (const entry of parsed) {
        const persona = entryPersona(entry);
        if (persona === null || seen.has(persona.name)) continue;
        seen.add(persona.name);
        candidates.push(persona);
      }

      const personas = candidates.slice(0, MAX_ROSTER_PERSONAS);
      const dropped = Math.max(0, candidates.length - MAX_ROSTER_PERSONAS);
      if (dropped !== loggedDropped) {
        if (dropped > 0) {
          log(
            `fleet roster: dropped ${String(dropped)} persona(s) past the ` +
              `${String(MAX_ROSTER_PERSONAS)} cap`,
          );
        }
        loggedDropped = dropped;
      }

      held = personas;
      return held;
    },
  };
}
