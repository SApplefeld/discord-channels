// The one rate-limited repeat logger the broker's log surfaces write a repeating line through: the
// tailer, the question desk, the interaction router, the inbox judge, the pin keeper and the three
// standing cards. Each surface owns its window, its key cap and its text, which operators and
// memory records grep for, so each hands this module a description of its own two lines and this
// module owns only the counting.
//
// Two limiters with the same core stay local to their own layers: the intake's refusal limiter
// writes through a Logger's warn level, and the router's drop limiter folds the count into the line
// it keys on rather than writing a line of its own.

/**
 * One log surface's repeat logger: how long its window is, how many keys it holds, and the exact
 * text of its two lines.
 *
 * `Detail` is what a call carries beside its key, which is never part of the key: a byte count, an
 * offset, Discord's own refusal text, a session id. A key carries nothing that varies per repeat, so
 * one cause repeating is one key however its details differ.
 */
export type RepeatLogSurface<Detail extends readonly unknown[]> = {
  /** How long a run of one key is aggregated before its next line. */
  windowMs: number;
  /**
   * How many keys are held before the closed windows are swept. Absent where the keys are a closed
   * set, which bounds the map without a sweep.
   */
  maxKeys?: number;
  /** The line written for the first call of a key, and for the first call after its window closes. */
  firstLine: (key: string, ...detail: Detail) => string;
  /** The line naming how many calls of a key the window it just closed counted and did not write. */
  countLine: (key: string, suppressed: number) => string;
};

/**
 * Rate-limits a repeating log line by its key.
 *
 * A repeating line is not a one-off: a session whose transcript cannot be opened logs on every
 * poll, and a refresh timer produces the same refusal on every tick, for as long as the cause
 * lasts, and one line each would push earlier evidence out through rotation. The first call of a key
 * writes its line at once; a repeat inside the window is counted and written nowhere, and the count
 * rides on the next line that key's window admits, written just before it. No timer runs: the count
 * is written lazily, on the next call, which keeps this free of anything to clear on shutdown and
 * drivable by an injected clock in a test. So a trailing count is never flushed when a key's calls
 * stop, and stays unwritten where no later call of that key comes.
 *
 * The window is refreshed before either line is written, so a log that throws cannot leave it stale
 * and turn every later call of the key into a fresh line.
 *
 * With a key cap, a call that takes the map past it sweeps the closed windows, oldest first, until
 * the map is back at the cap, and whatever each swept key still owes is written on the way out. A
 * key that carries a session id, left in the map because it owes a count, is one only that same
 * session could ever flush, and a session that went away never will: the map would then grow by one
 * for the life of the process. The open windows are left alone, where the count riding on the next
 * line of a key is still that key's to report.
 */
export function createRepeatLog<Detail extends readonly unknown[]>(
  surface: RepeatLogSurface<Detail>,
  log: (message: string) => void,
  now: () => number,
): (key: string, ...detail: Detail) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (key, ...detail) => {
    const at = now();
    const held = state.get(key);
    if (held !== undefined && at - held.windowStart < surface.windowMs) {
      held.suppressed += 1;
      return;
    }
    state.set(key, { windowStart: at, suppressed: 0 });
    if (held !== undefined && held.suppressed > 0) log(surface.countLine(key, held.suppressed));
    log(surface.firstLine(key, ...detail));
    if (surface.maxKeys === undefined || state.size <= surface.maxKeys) return;
    const closed = [...state]
      .filter(([, kept]) => at - kept.windowStart >= surface.windowMs)
      .sort(([, left], [, right]) => left.windowStart - right.windowStart);
    for (const [closedKey, kept] of closed) {
      if (state.size <= surface.maxKeys) return;
      if (kept.suppressed > 0) log(surface.countLine(closedKey, kept.suppressed));
      state.delete(closedKey);
    }
  };
}
