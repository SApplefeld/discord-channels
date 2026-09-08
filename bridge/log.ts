// Reading a DSH session log off disk, which is where the bridge learns everything the notification
// stream does not carry: what a session did before this bridge existed, and the permission knobs,
// which are written before the runtime's first notification interval and so never reach a
// subscriber at all.
//
// The file is a container of concatenated Zstandard frames, one per append, holding newline-
// delimited JSON events. Node's `zstdDecompressSync` and `createZstdDecompress` both stop after the
// first frame, so decompressing the file as a unit returns one frame's lines from a file of
// thousands and looks exactly like a working reader. This module walks the container frame by
// frame, taking each frame's length from its own header.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { isRecord, metaValue, untrustedLine } from "./protocol.ts";

/** The Zstandard frame magic, little-endian, which starts every frame in the container. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FRAME_MAGIC_LE = 0xfd2fb528;

/** Bytes of dictionary id, by the frame header descriptor's dictionary-id flag. */
const DICTIONARY_ID_SIZES = [0, 1, 2, 4];

/** Bytes of frame content size, by the descriptor's content-size flag; flag 0 is a special case. */
const CONTENT_SIZE_SIZES = [0, 2, 4, 8];

/** How many events `dsh_tail` returns when the caller names no count. */
export const DEFAULT_TAIL_COUNT = 40;

/**
 * The most of one status field this reader hands back, in code points.
 *
 * The last event's type and the three permission knobs are read out of the log and rendered one to
 * a line in a `dsh_status` result. The log is written by the worker's own unsandboxed runtime and
 * is a file anything running as this user can write, so a field carried whole is a status line of
 * whatever length that writer chose, and one carried raw is a line break where the model reads two
 * lines. `dsh_tail` bounds every line it returns; this is that boundary for the other reader, and
 * it is applied here rather than at the render, so a second caller cannot reach the raw value.
 */
export const MAX_STATUS_VALUE = 120;

/**
 * The most plaintext one frame is decompressed to, in bytes.
 *
 * A frame's header declares its content size and nothing checks that declaration against anything:
 * a corrupt or hostile frame can ask for gigabytes, and the decompressor will try, which takes the
 * whole bridge down with it and every session it was serving. The writer appends one frame per
 * write, a handful of events at a time, so the bound is orders of magnitude above any frame that
 * writer produces; the measurement it was set against is in the DSH bridge plan's Chapters.
 */
const MAX_FRAME_PLAINTEXT = 16 * 1024 * 1024;

/**
 * The largest session log `dsh_tail` opens, in bytes.
 *
 * Per-frame plaintext is bounded above, and the container was not: the whole file is read into
 * memory on every call. The bound is an order of magnitude above a long-running session's log and
 * still one a bridge serving a Claude session can afford to hold at once; the measurement it was set
 * against is in the DSH bridge plan's Chapters. The counts-only read `dsh_status` makes takes the
 * lower {@link MAX_STATUS_LOG_BYTES} instead.
 *
 * Past it the file is refused rather than partly read: the counts this reader returns are of the
 * whole log, and a tail taken off the end would report a session's turns, steps and compactions as
 * whatever fell inside the last few megabytes, which is a wrong number rather than a missing one.
 */
export const MAX_LOG_BYTES = 128 * 1024 * 1024;

/**
 * The largest session log the counts-only read opens, in bytes.
 *
 * `dsh_status` reads the whole log for its counts, on every call, synchronously, on the event loop
 * that also pumps the runtime's notifications and delivers every channel event. So this is a latency
 * budget rather than a memory one: it bounds how long one status call can hold that loop, and it
 * sits well under {@link MAX_LOG_BYTES}, which bounds `dsh_tail`, a tool whose whole subject is the
 * log and whose caller has asked to wait for it. Past it the counts are not read and the status says
 * so beside the fields that come from the child and need no log; the tail still opens the same file
 * up to its own ceiling. The measurement this figure was set against is in the DSH bridge plan's
 * Chapters.
 */
export const MAX_STATUS_LOG_BYTES = 16 * 1024 * 1024;

/**
 * How much plaintext a read may decompress for each byte of container it opens.
 *
 * The per-frame ceiling bounds one frame and a container ceiling bounds the file, and neither bounds
 * their product: a run-length frame is a few bytes on disk whatever it decodes to, so a container
 * well under its ceiling can be a run of frames each just under theirs, and the read is then the
 * decode and the parse of all of it on the event loop that also serves every session. Four to one
 * is a ratio a log written one small frame per append compresses nowhere near, so a log at either
 * ceiling is read whole; past the budget the read stops and the rest is counted as unread, exactly
 * as a frame past its own ceiling is.
 */
const PLAINTEXT_RATIO = 4;

/** The most plaintext `dsh_tail`'s read decompresses across every frame of a container, in bytes. */
export const MAX_TOTAL_PLAINTEXT = PLAINTEXT_RATIO * MAX_LOG_BYTES;

/**
 * The shape of a session id, which is a UUID the runtime minted under a `session-` prefix.
 *
 * Two spellings are live: the SDK client mints `session-` plus a UUID with its dashes removed, and
 * the sessions in the operator's harness home carry the dashed spelling. Both are matched, and
 * nothing else is, because this string is joined into a filesystem path.
 */
const SESSION_ID = /^session-[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

/**
 * Whether `value` is a session id a DSH runtime minted.
 *
 * The guard on the one place stored text becomes a path segment. The state file is the bridge's own
 * memory and is still a file on disk: an id read back out of it carrying `..` or a separator would
 * walk `sessionLogFile` out of the harness home and hand whatever it found there to the model as a
 * session log.
 */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/**
 * Whether `value` is a turn number a session can have run: a whole, non-negative, safe integer.
 *
 * The one guard for the field wherever it is read off disk, the session log and the state file
 * alike. A turn number reaches arithmetic, a `Math.max` and the model's `turn` attribute, and
 * `1e300`, a fraction and a negative all parse as numbers without being a turn any session ran.
 */
export function isTurnNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The event types the default filter drops: the streaming pieces the runtime writes beside the
 * assembled `assistant/message` and `tool/call` events that restate them.
 *
 * On the on-disk session log, which is the surface this reader opens, all four are top-level event
 * types: `assistant/chunk` is one delta to a line, and the persistence layer packs a run of deltas
 * of one block into a single `text-chunks`, `tool-call-chunks` or `reasoning-chunks` row. The deltas
 * and the packed rows are the most numerous lines in a busy session's file, so a default that
 * admitted any of them would fill a forty-line tail with deltas and push the `turn/end`, `tool/call`
 * and `assistant/message` events the tool exists to surface out of the window. The SDK notification
 * stream carries the same deltas in a different shape, nested under `assistant/chunk`, and says
 * nothing about this file. `reasoning-chunks` is in the list whether or not a given log carries it,
 * since dropping a type that never appears costs nothing.
 */
export const CHUNK_TYPES = ["assistant/chunk", "text-chunks", "tool-call-chunks", "reasoning-chunks"] as const;

/** What a log says about a session, for `dsh_status`, plus the lines `dsh_tail` asked for. */
export interface LogReading {
  /** The last events matching the filter, oldest first, one line each. */
  readonly lines: string[];
  /** Every event the file holds, including the ones the filter dropped. */
  readonly events: number;
  /** The highest turn number any event names. */
  readonly turns: number;
  /** How many steps were opened across every turn. */
  readonly steps: number;
  /** How many compactions completed. */
  readonly compactions: number;
  /** The type of the last event in the file, or the empty string for an empty log. */
  readonly lastEventType: string;
  /** The permission preset, sandbox mode and approval policy in force, each as last written. */
  readonly permission: Record<string, string>;
  /**
   * Bytes of the container this reader could not read as frames, zero when it read the whole file.
   *
   * The walk stops at the first frame it cannot decode, one that decodes past the per-frame ceiling
   * or past what is left of the plaintext budget, bytes that are not a frame at all, or a trailing
   * frame the buffer is too short to hold, and the counts above are of the frames before that point. Carried out rather than swallowed so a reader
   * of `dsh_status` is told the counts cover a prefix, which is the difference between a number that
   * is short and one that is wrong.
   */
  readonly unreadBytes: number;
}

interface TailOptions {
  /** How many lines to keep. Zero reads the file for its counts alone. */
  readonly count: number;
  /** The types to admit. Undefined admits everything except {@link CHUNK_TYPES}. */
  readonly kinds?: readonly string[];
  /** The container ceiling, {@link MAX_LOG_BYTES} unless a caller names a smaller one. */
  readonly maxBytes?: number;
  /** The plaintext budget across the walk, {@link MAX_TOTAL_PLAINTEXT} unless a caller names a smaller one. */
  readonly maxPlaintext?: number;
}

/**
 * The session log for `sessionId` under `home`, or undefined when the session has none on disk.
 *
 * Found by scanning the workspace-key directories rather than by deriving the key from a path: the
 * key is DSH's own encoding of a workspace path and nothing documents it, so a derivation that
 * drifts would report a live session as absent. A session id is unique across the home, so the
 * first directory holding it is the one.
 *
 * Generations share a directory (`session.jsonl` is generation zero, `session.vN.jsonl` the later
 * ones, either optionally Zstandard-compressed) and the highest one is the live log. Both spellings
 * of one generation can sit there at once, and the compressed one wins: that is the shape the
 * runtime appends to, so the plain file beside it is a copy somebody made and is not being written.
 * Decided here rather than left to `readdirSync` order, which is the filesystem's to choose.
 *
 * The session id is refused unless it is one a runtime minted, because it is joined into a path
 * here and it was read back out of a file on disk.
 */
export function sessionLogFile(home: string, sessionId: string): string | undefined {
  if (!isSessionId(sessionId)) {
    throw new Error(`'${[...sessionId].slice(0, 64).join("")}' is not a DSH session id, so no log path is built from it.`);
  }
  const root = path.join(home, "sessions");
  if (!existsSync(root)) return undefined;
  for (const workspace of readdirSync(root)) {
    const directory = path.join(root, workspace, sessionId);
    if (!existsSync(directory)) continue;
    let best: { generation: number; compressed: boolean; file: string } | undefined;
    for (const name of readdirSync(directory)) {
      const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
      if (match === null) continue;
      const generation = match[1] === undefined ? 0 : Number(match[1]);
      const compressed = match[2] !== undefined;
      const better =
        best === undefined || generation > best.generation || (generation === best.generation && compressed && !best.compressed);
      if (better) best = { generation, compressed, file: path.join(directory, name) };
    }
    if (best !== undefined) return best.file;
  }
  return undefined;
}

/**
 * The byte length of the whole frame beginning at `at`, or undefined when the buffer holds less
 * than that frame or the bytes are not a frame at all.
 *
 * A frame's length is in its own structure and nowhere else: the header descriptor says which
 * optional fields follow it, and each block header then names its block's size, the last block
 * carrying a flag that ends the frame. Scanning for the next magic sequence instead would be wrong
 * rather than merely slow, because those four bytes occur inside compressed payloads, and a
 * boundary taken from one of them cuts a frame in half and puts every later boundary on garbage.
 *
 * The frame format is RFC 8878. Skippable frames are not read: this container is written by one
 * appender that writes nothing but Zstandard frames, and a magic that is not the one below is
 * therefore the end of what can be read rather than a frame to step over.
 */
function frameLength(buffer: Buffer, at: number): number | undefined {
  if (at + 5 > buffer.length || buffer.readUInt32LE(at) !== FRAME_MAGIC_LE) return undefined;
  const descriptor = buffer[at + 4];
  // Bit 3 is reserved and must be zero; a set bit means these are not the header bytes they look
  // like, and every length derived from them would be invented.
  if ((descriptor & 0x08) !== 0) return undefined;
  const singleSegment = (descriptor & 0x20) !== 0;
  const contentSizeFlag = descriptor >> 6;
  let cursor = at + 5;
  if (!singleSegment) cursor += 1;
  cursor += DICTIONARY_ID_SIZES[descriptor & 0x03];
  // A content-size flag of zero means one byte when the frame is a single segment and no field at
  // all otherwise, which is the one place the field's size is not read straight off the flag.
  cursor += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : CONTENT_SIZE_SIZES[contentSizeFlag];

  for (;;) {
    if (cursor + 3 > buffer.length) return undefined;
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
    cursor += 3;
    const blockType = (header >> 1) & 0x03;
    // A run-length block is one byte on the wire whatever it expands to; the reserved type is not a
    // block at all.
    if (blockType === 3) return undefined;
    cursor += blockType === 1 ? 1 : header >> 3;
    if (cursor > buffer.length) return undefined;
    if ((header & 0x01) === 1) break;
  }
  if ((descriptor & 0x04) !== 0) cursor += 4;
  return cursor > buffer.length ? undefined : cursor - at;
}

/**
 * The plaintext of every complete frame in `buffer`, in order, returning how many bytes it left
 * unread.
 *
 * The last frame may be half-written, because the reader arrived between the writer's `write` and
 * its completion. It is dropped: its own header says how long it should be, the buffer is shorter
 * than that, and the events it holds arrive whole on the next read. A truncated frame is not
 * self-announcing to the decoder, which returns the plaintext of whatever whole blocks it found
 * without complaint, so the length check is what drops it.
 *
 * Every byte the walk does not read is counted, whatever stopped it: bytes before the first frame,
 * the frame it could not decode and everything after it, the frame that would pass the plaintext
 * `budget` and everything after it, or the torn tail. The count is the generator's return value, so
 * the caller that consumes the frames one at a time is told at the end whether it saw the whole file.
 */
function* frames(buffer: Buffer, budget: number): Generator<string, number> {
  // Where the first frame starts, in case anything precedes it. Every frame after it is found by
  // its predecessor's length rather than by another search.
  const first = buffer.indexOf(FRAME_MAGIC, 0);
  if (first === -1) return buffer.length;
  let at = first;
  let remaining = budget;
  while (at < buffer.length) {
    const length = frameLength(buffer, at);
    if (length === undefined || remaining <= 0) break;
    let text: string;
    try {
      // What is left of the budget is the most this frame may decode to, so a frame that would pass
      // it fails its decode exactly as one past its own ceiling does, and the walk ends at it.
      const plain = zstdDecompressSync(buffer.subarray(at, at + length), { maxOutputLength: Math.min(MAX_FRAME_PLAINTEXT, remaining) });
      remaining -= plain.length;
      text = plain.toString("utf8");
    } catch {
      // A frame whose header parsed and whose payload will not decode is one this reader cannot
      // walk past: the bytes after it are only a frame if this one really was as long as it said.
      // A frame that decodes past the ceiling ends the read on the same reasoning, since a frame
      // that size is not one this writer wrote.
      break;
    }
    yield text;
    at += length;
  }
  return first + (buffer.length - at);
}

/**
 * The largest and smallest epoch milliseconds a `Date` can carry. Past them `toISOString` throws a
 * `RangeError`, and `1e300` is a number JSON parses without complaint.
 */
const MAX_TIME = 8.64e15;

/** An event's time as an ISO string, or `-` when it has none this reader can render. */
function renderTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_TIME) return "-";
  return new Date(value).toISOString();
}

/**
 * One event as a line: what it was, when, and its own payload, neutralized and bounded.
 *
 * The type and the payload are the writer's own text, and the writer is the worker's unsandboxed
 * runtime, so the whole line goes through the same neutralizer every other worker-written text
 * reaching the model does: `JSON.stringify` escapes the C0 controls and nothing else, so a
 * zero-width point, a line separator, a bidirectional override or a forged harness tag inside a
 * payload would otherwise reach the model as written.
 */
function render(event: Record<string, unknown>): string {
  const seq = typeof event.seq === "number" ? String(event.seq) : "-";
  const time = renderTime(event.time);
  const type = typeof event.type === "string" ? event.type : "?";
  const data = event.data === undefined ? { ...event, type: undefined } : event.data;
  return untrustedLine(`${seq} ${time} ${type} ${JSON.stringify(data)}`);
}

/**
 * Read one session log: its counts, and the last `count` events matching the filter.
 *
 * One pass over the file serves both, because the file is the expensive part: a session that has
 * run for a day is several megabytes across ten thousand frames, and reading it twice to answer one
 * tool call buys nothing. The frames are decoded one at a time and only the kept events are held, so
 * what a long log costs is its decode and one frame of plaintext rather than all of it at once.
 */
export function readSessionLog(file: string, options: TailOptions): LogReading {
  const admitted = options.kinds === undefined ? undefined : new Set(options.kinds);
  const kept: Record<string, unknown>[] = [];
  const permission: Record<string, string> = {};
  let events = 0;
  let turns = 0;
  let steps = 0;
  let compactions = 0;
  let lastEventType = "";

  const ceiling = options.maxBytes ?? MAX_LOG_BYTES;
  const size = statSync(file).size;
  // The file's role rather than its path: this message reaches the model through a tool result, and
  // the path runs through the harness home, which carries the operator's user name.
  if (size > ceiling) {
    throw new Error(
      `This session's log is ${String(size)} bytes, past the ${String(ceiling)} this reader opens at once. ` +
        "Read it with a tool that streams, or start a fresh session.",
    );
  }
  const raw = readFileSync(file);
  // Each frame is one append of whole, newline-terminated events, so a frame is split on its own
  // newlines: no event straddles a frame boundary, and a frame whose plaintext is not the events it
  // should be (a truncated or corrupt one) is refused line by line here rather than leaking its
  // bytes into the next frame's first line.
  const consume = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A line that is not JSON is not this reader's to repair: the writer owns the file and is
        // still appending to it.
        continue;
      }
      // A line that parses to a number, a string or null is JSON without being an event, and
      // reading a field off it would end the whole read over one malformed line.
      if (!isRecord(parsed)) continue;
      const event = parsed;
      events += 1;
      const type = typeof event.type === "string" ? event.type : "?";
      // The type is bounded for the status field it becomes; the tail's own line keeps the type as
      // it was written, inside a line that is bounded whole.
      lastEventType = metaValue(type, MAX_STATUS_VALUE);
      const data = isRecord(event.data) ? event.data : {};
      if (isTurnNumber(data.turn) && data.turn > turns) turns = data.turn;
      if (type === "step/start") steps += 1;
      if (type === "compaction/end") compactions += 1;
      if (type === "permission/preset" && typeof data.preset === "string") permission.preset = metaValue(data.preset, MAX_STATUS_VALUE);
      if (type === "sandbox/mode" && typeof data.mode === "string") permission.sandbox = metaValue(data.mode, MAX_STATUS_VALUE);
      if (type === "approval/policy" && typeof data.policy === "string") permission.approval = metaValue(data.policy, MAX_STATUS_VALUE);

      if (options.count <= 0) continue;
      const keep = admitted === undefined ? !CHUNK_TYPES.includes(type as (typeof CHUNK_TYPES)[number]) : admitted.has(type);
      if (!keep) continue;
      // Held parsed and rendered only once the walk is over. A render is a stringify and a walk of
      // the line's code points through the neutralizer, and on a long log almost every admitted
      // event is pushed out of the window by a later one, so rendering each as it arrives would
      // spend that on every admitted event in the file rather than on the `count` that survive.
      kept.push(event);
      if (kept.length > options.count) kept.shift();
    }
  };
  // A plain log is one text and is read whole; a container is walked frame by frame, and the walk's
  // return value says how much of it was not read.
  let unreadBytes = 0;
  if (file.endsWith(".zstd")) {
    const walk = frames(raw, options.maxPlaintext ?? MAX_TOTAL_PLAINTEXT);
    for (let step = walk.next(); ; step = walk.next()) {
      if (step.done) {
        unreadBytes = step.value;
        break;
      }
      consume(step.value);
    }
  } else {
    consume(raw.toString("utf8"));
  }
  return { lines: kept.map(render), events, turns, steps, compactions, lastEventType, permission, unreadBytes };
}

/**
 * Read one session log for its counts alone, under the bound `dsh_status` reads at.
 *
 * The same walk as {@link readSessionLog} with no lines kept, under {@link MAX_STATUS_LOG_BYTES} and
 * the matching plaintext budget rather than the tail's ceilings, because this read happens on every
 * status call and holds the event loop that delivers every channel event for as long as it runs. A
 * log past the bound is refused with a sentence that names the tool which still reads it, since the
 * tail's ceiling is the larger one and a status that said "start a fresh session" over a log the
 * tail opens without complaint would be sending the model the wrong way.
 */
export function readSessionCounts(file: string): LogReading {
  const size = statSync(file).size;
  if (size > MAX_STATUS_LOG_BYTES) {
    throw new Error(
      `This session's log is ${String(size)} bytes, past the ${String(MAX_STATUS_LOG_BYTES)} a status reads for its counts. ` +
        "dsh_tail still reads its last events.",
    );
  }
  return readSessionLog(file, { count: 0, maxBytes: MAX_STATUS_LOG_BYTES, maxPlaintext: PLAINTEXT_RATIO * MAX_STATUS_LOG_BYTES });
}
