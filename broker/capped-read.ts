// The one capped file read every board and usage reader opens a file through: at most a fixed
// number of bytes, refused whole rather than truncated when the file runs over that cap.
//
// A recognizer running on a cut copy can manufacture a match the full text never held, so a file
// over the cap is a failure rather than the prefix that fit. Every failure, whatever stage it
// happened at, reports "unreadable" without inspecting why: an absent file, a permission refusal
// and a read that failed after the open succeeded all cost a caller nothing different, and the
// underlying errors are discarded unread because each one carries the path, which typically embeds
// the operator's own OS account name.
import { closeSync, openSync, readSync } from "node:fs";

/** What one capped read yields: the file's text, or why there is none. */
export type CappedRead = { text: string } | { failed: "unreadable" | "oversized" };

/** The shape of `readSync`'s own parameters and return, so a test can inject a reader that
 * delivers a file across more than one call without touching the read loop itself. */
export type CappedReader = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

/**
 * One read of at most `maxBytes`, into a buffer one byte larger so an oversized file is recognized
 * by the read itself rather than by a stat the file could have outgrown in between. The buffer is
 * uninitialized because only the bytes the read actually returned are ever decoded, so nothing
 * beyond them can escape.
 *
 * The read repeats until the buffer fills or a read returns nothing, because one `readSync` is
 * allowed to return fewer bytes than asked for and a network filesystem does. Stopping at the
 * first short read would hand the caller a prefix of the file under the name of the whole, which
 * is the cut copy this module refuses to recognize anything from.
 *
 * `read` defaults to `readSync` and is injected so a test can prove the loop against a reader that
 * delivers a file in more than one chunk, which a real short read on disk cannot be provoked to do
 * on demand.
 *
 * The close carries its own guard rather than riding a bare `finally`: a close that throws there
 * replaces whatever the read produced, so a healthy read would surface as a failure and a failed
 * one would surface with the wrong reason.
 */
export function readCappedFile(
  file: string,
  maxBytes: number,
  read: CappedReader = readSync,
): CappedRead {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return { failed: "unreadable" };
  }
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const got = read(handle, buffer, filled, buffer.length - filled, filled);
      if (got === 0) break;
      filled += got;
    }
    if (filled > maxBytes) return { failed: "oversized" };
    return { text: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { failed: "unreadable" };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that will not close is the operating system's problem, not the caller's: the
      // reading in hand, good or bad, is already decided.
    }
  }
}
