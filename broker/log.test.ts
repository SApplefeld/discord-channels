import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./log.ts";
import { createHandler } from "./intake.ts";
import { createRegistry } from "./registry.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-log-"));
  return { dir, file: path.join(dir, "broker.log") };
}

test("a logger with no file configured is a silent no-op", () => {
  const logger = createLogger({ file: null, maxBytes: 1024, maxFiles: 3 });
  // Nothing to assert on disk; the point is that none of these throw.
  logger.info("hello");
  logger.warn("hello");
  logger.error("hello");
});

test("logged lines land on disk with a level and a timestamp", () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    logger.info("broker: listening");
    logger.warn("broker: something to watch");
    logger.error("broker: something broke");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.*\[info] broker: listening$/);
    assert.match(lines[1], /\[warn] broker: something to watch$/);
    assert.match(lines[2], /\[error] broker: something broke$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log write that cannot succeed is dropped, not thrown", () => {
  // The parent of the log path is a file, so every append fails.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-log-bad-"));
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "", "utf8");
  const file = path.join(blocker, "broker.log");

  try {
    const logger = createLogger({ file, maxBytes: 1024, maxFiles: 3 });
    assert.doesNotThrow(() => logger.error("this can never land anywhere"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every `LINE <n>` marker found in a file's content, or an empty array if the file is absent. */
function lineNumbersIn(file: string): number[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/LINE (\d+)/g)].map((match) => Number(match[1]));
}

test("the active file rotates once it crosses the size cap, keeping the file count", () => {
  const { dir, file } = tmpFile();
  try {
    // Small enough that a handful of log lines cross it, so the test does not need to write
    // megabytes to observe rotation.
    const logger = createLogger({ file, maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 40; i += 1) {
      logger.info(`LINE ${i}: padded out to push the file past the size cap quickly`);
    }
    // A write that itself crosses the cap rotates immediately after landing, so the active file can
    // momentarily not exist until the next write recreates it (appendFileSync creates a missing
    // file). One more write settles that before asserting on the active file's existence.
    logger.info("LINE 40: settle");

    assert.ok(existsSync(file), "the active file should exist after the last write");
    assert.ok(existsSync(`${file}.1`), "a rotated predecessor should exist");
    // maxFiles is a total (active plus rotated), so file.2 is one slot past what 3 allows to be
    // full at once, but should never exceed maxFiles - 1 rotated files.
    assert.ok(!existsSync(`${file}.3`), "no more than maxFiles total files should ever exist");

    // The direction of rotation, not just the file count: a rotate that shifted the wrong way
    // would still pass every assertion above while serving the oldest lines as if they were the
    // newest. The active file's lines must be strictly newer than file.1's.
    const activeMax = Math.max(...lineNumbersIn(file));
    const rotatedLines = lineNumbersIn(`${file}.1`);
    assert.ok(rotatedLines.length > 0, "file.1 must hold real lines, not be empty");
    assert.ok(
      activeMax > Math.max(...rotatedLines),
      `expected the active file's newest line (${activeMax}) to exceed file.1's newest ` +
        `(${Math.max(...rotatedLines)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation retires the oldest file rather than growing without bound, oldest lines first", () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 50, maxFiles: 2 });
    for (let i = 0; i < 30; i += 1) {
      logger.info(`LINE ${i}: with enough padding to roll over the fifty byte cap`);
    }
    logger.info("LINE 30: settle");

    assert.ok(existsSync(file));
    assert.ok(existsSync(`${file}.1`));
    assert.ok(!existsSync(`${file}.2`), "maxFiles of 2 permits only the active file and one rotated");

    // file.2 never existing is necessary but not sufficient: a rotate that dropped the newest lines
    // instead of the oldest would also leave no file.2, while serving stale content as current.
    const activeLines = lineNumbersIn(file);
    const rotatedLines = lineNumbersIn(`${file}.1`);
    assert.ok(activeLines.length > 0 && rotatedLines.length > 0);
    assert.ok(
      Math.min(...activeLines) > Math.max(...rotatedLines),
      `expected every active line (min ${Math.min(...activeLines)}) to be newer than every ` +
        `file.1 line (max ${Math.max(...rotatedLines)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an untrusted name cannot forge a second log line", () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    logger.warn("hook dropped: name=evil\nfake line injected by an attacker-controlled name");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "the embedded newline must not become a second line");
    assert.ok(!lines[0].includes("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bidi and zero-width characters are stripped from a logged name", () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    logger.warn("session name=safe‮exe.txt​");

    const contents = readFileSync(file, "utf8");
    assert.ok(!contents.includes("‮"));
    assert.ok(!contents.includes("​"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The intake handler is where a forged or misrouted hook post is otherwise invisible: it answers
// with a plain HTTP status and nothing else. These lock that the logger sees the events that matter
// and never sees the process token, the forgery key those same posts carry.
const TOKEN = "5f0c2e4a-0000-4000-8000-000000000099";

function fakeRequest(
  remoteAddress: string | undefined,
  init: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const body = init.body ?? "";
  const request = {
    method: init.method ?? "POST",
    url: init.url ?? "/hook",
    headers: { host: "127.0.0.1:8787", ...(init.headers ?? {}) },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body, "utf8");
    },
  };
  return request as unknown as IncomingMessage;
}

function fakeResponse(): { response: ServerResponse; done: Promise<void> } {
  let settle: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const response = {
    headersSent: false,
    writeHead() {
      this.headersSent = true;
      return this;
    },
    end() {
      settle();
    },
  };
  return { response: response as unknown as ServerResponse, done };
}

test("a hook post accepted and dropped by the registry is logged, without the process token", async () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger });

    const { response, done } = fakeResponse();
    handle(
      fakeRequest("127.0.0.1", {
        headers: {
          "x-channel-hook-event": "PostToolUse",
          "x-channel-process-token": TOKEN,
          "x-channel-session-name": "neo-intake",
        },
        body: JSON.stringify({ tool_name: "Bash" }),
      }),
      response,
    );
    await done;

    const contents = readFileSync(file, "utf8");
    assert.ok(contents.includes("hook dropped"), contents);
    assert.ok(contents.includes("event=PostToolUse"), contents);
    assert.ok(!contents.includes(TOKEN), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Host header logged on refusal is capped rather than written verbatim", async () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger });

    const hugeHost = "a".repeat(20_000);
    const { response, done } = fakeResponse();
    handle(
      fakeRequest("127.0.0.1", {
        headers: { host: hugeHost },
        method: "GET",
        url: "/sessions",
      }),
      response,
    );
    await done;

    const contents = readFileSync(file, "utf8");
    assert.ok(!contents.includes(hugeHost), "the raw 20,000-character header must not land verbatim");
    assert.ok(contents.length < 1000, `expected a capped log line, got ${contents.length} bytes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated refusals of the same reason are aggregated rather than logged one per request", async () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    let now = 0;
    const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger, now: () => now });

    for (let i = 0; i < 50; i += 1) {
      const { response, done } = fakeResponse();
      handle(fakeRequest("192.168.1.5", { method: "GET", url: "/sessions" }), response);
      await done;
    }

    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.ok(
      lines.length < 50,
      `50 identical refusals inside one window must not become 50 log lines, got ${lines.length}`,
    );

    // Moving past the window opens a fresh line rather than suppressing forever, and the
    // suppressed count from the closed window is flushed first.
    now = 120_000;
    const { response, done } = fakeResponse();
    handle(fakeRequest("192.168.1.5", { method: "GET", url: "/sessions" }), response);
    await done;

    const afterWindow = readFileSync(file, "utf8");
    assert.match(afterWindow, /occurred \d+ more time\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused non-loopback request is logged", async () => {
  const { dir, file } = tmpFile();
  try {
    const logger = createLogger({ file, maxBytes: 1024 * 1024, maxFiles: 3 });
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger });

    const { response, done } = fakeResponse();
    handle(
      fakeRequest("192.168.1.5", {
        headers: {
          "x-channel-hook-event": "SessionStart",
          "x-channel-process-token": TOKEN,
        },
        body: JSON.stringify({ session_id: "session-a" }),
      }),
      response,
    );
    await done;

    const contents = readFileSync(file, "utf8");
    assert.ok(contents.includes("non-loopback"), contents);
    assert.ok(!contents.includes(TOKEN), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
