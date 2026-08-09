import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_USAGE_ACCOUNTS, MAX_USAGE_FILE_BYTES, readUsage } from "./cache.ts";

// Every fixture here is synthetic. The real files on this host carry the operator's account
// addresses, so nothing read off them is reproduced in the repo.
const FETCHED_AT_SECONDS = 1_786_295_298.9466488;
const RESETS_AT = "2026-08-13T18:00:00.391863+00:00";

type Scratch = {
  root: string;
  writeUsage: (value: unknown) => void;
  writeRaw: (value: string) => void;
  writeSequence: (value: unknown) => void;
  cleanup: () => void;
};

function scratch(): Scratch {
  const root = mkdtempSync(path.join(os.tmpdir(), "channels-usage-"));
  mkdirSync(path.join(root, "cache"), { recursive: true });
  const usageFile = path.join(root, "cache", "usage.json");
  return {
    root,
    writeUsage: (value) => writeFileSync(usageFile, JSON.stringify(value), "utf8"),
    writeRaw: (value) => writeFileSync(usageFile, value, "utf8"),
    writeSequence: (value) =>
      writeFileSync(path.join(root, "sequence.json"), JSON.stringify(value), "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The shape claude-swap writes for a healthy account, as one whole `accounts` entry. */
function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "one@example.test",
    organizationUuid: "00000000-0000-4000-8000-000000000001",
    claimId: null,
    consecutiveFailures: 0,
    lastError: null,
    backoffUntil: null,
    lastAttemptAt: FETCHED_AT_SECONDS,
    lastGood: {
      five_hour: { pct: 4, resets_at: RESETS_AT, countdown: "4h 35m", clock: "17:50" },
      seven_day: { pct: 66, resets_at: RESETS_AT, countdown: "4d 0h", clock: "Aug 13 14:00" },
      spend: { used: 95.4, limit: 1500, pct: 6.36, currency: "USD" },
      scoped: [{ name: "Fable", pct: 100, resets_at: RESETS_AT, countdown: "4d 0h" }],
    },
    fetchedAt: FETCHED_AT_SECONDS,
    nextPollAt: FETCHED_AT_SECONDS + 600,
    pollIntervalS: 600,
    ...overrides,
  };
}

function sequence(numbers: number[], active: number): Record<string, unknown> {
  const accounts: Record<string, unknown> = {};
  for (const number of numbers) {
    accounts[String(number)] = {
      email: `account${number}@example.test`,
      uuid: "00000000-0000-4000-8000-000000000002",
      organizationName: `Org ${number}`,
      added: "2026-08-05T19:39:07Z",
    };
  }
  return { activeAccountNumber: active, lastUpdated: "2026-08-09T13:59:07Z", sequence: numbers, accounts };
}

test("both files read into accounts ordered by number, with the active one marked", () => {
  const held = scratch();
  try {
    held.writeUsage({ schemaVersion: 2, accounts: { "3": account(), "1": account(), "2": account() } });
    held.writeSequence(sequence([2, 3, 1], 2));

    const reading = readUsage({ root: held.root });
    assert.equal(reading.available, true);
    assert.ok(reading.available);
    assert.deepEqual(
      reading.accounts.map((entry) => entry.number),
      [1, 2, 3],
      "ascending account number, not the rotation order the sequence array carries",
    );
    assert.deepEqual(
      reading.accounts.map((entry) => entry.active),
      [false, true, false],
    );
    assert.deepEqual(
      reading.accounts.map((entry) => entry.email),
      ["account1@example.test", "account2@example.test", "account3@example.test"],
      "the display identity comes from sequence.json, never from the cache's own copy",
    );
    assert.equal(reading.accounts[0].organizationName, "Org 1");
  } finally {
    held.cleanup();
  }
});

test("claude-swap's epoch-seconds timestamps are read as milliseconds", () => {
  const held = scratch();
  try {
    held.writeUsage({ schemaVersion: 2, accounts: { "1": account() } });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts[0].fetchedAt, Math.round(FETCHED_AT_SECONDS * 1000));
  } finally {
    held.cleanup();
  }
});

test("a window carrying only pct reads as a window with no reset time", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: {
        "1": account({
          lastGood: { five_hour: { pct: 0 }, seven_day: { pct: 70, resets_at: RESETS_AT } },
        }),
      },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.deepEqual(reading.accounts[0].fiveHour, { pct: 0, resetsAt: null });
    assert.equal(reading.accounts[0].sevenDay?.resetsAt, Date.parse(RESETS_AT));
  } finally {
    held.cleanup();
  }
});

test("an account with no spend block reads as no spend, not as a zero", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: { "1": account({ lastGood: { five_hour: { pct: 0 }, scoped: [{ name: "Fable", pct: 96 }] } }) },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts[0].spend, null);
    assert.equal(reading.accounts[0].sevenDay, null);
    assert.deepEqual(reading.accounts[0].scoped, [{ name: "Fable", pct: 96, resetsAt: null }]);
  } finally {
    held.cleanup();
  }
});

test("a failing account carries its failure flags rather than throwing", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: {
        "1": account({
          consecutiveFailures: 3,
          lastError: "401 from the upstream endpoint",
          backoffUntil: FETCHED_AT_SECONDS + 900,
        }),
      },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts[0].failing, true);
    assert.equal(
      reading.accounts[0].backoffUntil,
      Math.round((FETCHED_AT_SECONDS + 900) * 1000),
      "the instant itself, since claude-swap leaves the field set after the pause elapses",
    );
    assert.equal(reading.accounts[0].consecutiveFailures, 3);
  } finally {
    held.cleanup();
  }
});

test("a reset time with no offset is not a reset time", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: {
        "1": account({
          lastGood: {
            five_hour: { pct: 4, resets_at: "2026-08-13T18:00:00.391863" },
            seven_day: { pct: 66, resets_at: RESETS_AT },
          },
        }),
      },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    // Read as local time, that string would place the reset at this host's offset from the instant
    // claude-swap meant, and every countdown derived from it would be wrong by that many hours.
    assert.equal(reading.accounts[0].fiveHour?.resetsAt, null);
    assert.equal(reading.accounts[0].sevenDay?.resetsAt, Date.parse(RESETS_AT));
  } finally {
    held.cleanup();
  }
});

test("timestamps that overflow on conversion and counts that are nonsense are refused", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: { "1": account({ fetchedAt: 1e308, backoffUntil: 1e308, consecutiveFailures: -4.7 }) },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts[0].fetchedAt, null, "finite seconds can still be infinite milliseconds");
    assert.equal(reading.accounts[0].backoffUntil, null);
    assert.equal(reading.accounts[0].consecutiveFailures, 0);
  } finally {
    held.cleanup();
  }
});

test("the scoped cap counts rows that are readable, not entries that were tried", () => {
  const held = scratch();
  try {
    const scoped = [
      ...Array.from({ length: 12 }, () => ({ pct: 10 })),
      { name: "Fable", pct: 96, resets_at: RESETS_AT },
    ];
    held.writeUsage({
      schemaVersion: 2,
      accounts: { "1": account({ lastGood: { five_hour: { pct: 4 }, scoped } }) },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.deepEqual(reading.accounts[0].scoped, [
      { name: "Fable", pct: 96, resetsAt: Date.parse(RESETS_AT) },
    ]);
  } finally {
    held.cleanup();
  }
});

test("the account cap counts accounts that are readable, not keys that were tried", () => {
  const held = scratch();
  try {
    const accounts: Record<string, unknown> = {};
    for (let number = 1; number <= MAX_USAGE_ACCOUNTS; number += 1) accounts[String(number)] = "not a record";
    accounts[String(MAX_USAGE_ACCOUNTS + 1)] = account();
    held.writeUsage({ schemaVersion: 2, accounts });
    held.writeSequence(sequence([MAX_USAGE_ACCOUNTS + 1], MAX_USAGE_ACCOUNTS + 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.deepEqual(
      reading.accounts.map((entry) => entry.number),
      [MAX_USAGE_ACCOUNTS + 1],
      "unusable entries ahead of a readable one do not spend its slot",
    );
  } finally {
    held.cleanup();
  }
});

test("account keys that do not round-trip through a number are not accounts", () => {
  const held = scratch();
  try {
    held.writeUsage({
      schemaVersion: 2,
      accounts: { "1": account(), "01": account(), "007": account(), "12345678901234567890": account() },
    });
    held.writeSequence(sequence([1], 1));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.deepEqual(
      reading.accounts.map((entry) => entry.number),
      [1],
    );
  } finally {
    held.cleanup();
  }
});

test("a malformed usage cache reads as unavailable rather than throwing", () => {
  const held = scratch();
  try {
    held.writeRaw('{"schemaVersion": 2, "accounts": {"1": ');
    held.writeSequence(sequence([1], 1));

    assert.deepEqual(readUsage({ root: held.root }), { available: false, reason: "malformed" });
  } finally {
    held.cleanup();
  }
});

test("a usage cache that is the wrong shape reads as unavailable", () => {
  const held = scratch();
  try {
    held.writeUsage({ schemaVersion: 2, accounts: [] });
    held.writeSequence(sequence([1], 1));

    assert.deepEqual(readUsage({ root: held.root }), { available: false, reason: "malformed" });
  } finally {
    held.cleanup();
  }
});

test("a missing usage cache reads as unavailable rather than throwing", () => {
  const held = scratch();
  try {
    held.writeSequence(sequence([1], 1));

    assert.deepEqual(readUsage({ root: held.root }), { available: false, reason: "unreadable" });
  } finally {
    held.cleanup();
  }
});

test("a usage cache past the byte cap reads as unavailable and is not parsed", () => {
  const held = scratch();
  try {
    const padding = "x".repeat(MAX_USAGE_FILE_BYTES + 1);
    held.writeUsage({ schemaVersion: 2, padding, accounts: { "1": account() } });
    held.writeSequence(sequence([1], 1));

    assert.deepEqual(readUsage({ root: held.root }), { available: false, reason: "oversized" });
  } finally {
    held.cleanup();
  }
});

/** A whole, valid usage cache padded to exactly `bytes`, so the cap is exercised at its own edge. */
function usageOfExactly(bytes: number): string {
  const base = { schemaVersion: 2, padding: "", accounts: { "1": account() } };
  const room = bytes - Buffer.byteLength(JSON.stringify(base), "utf8");
  assert.ok(room >= 0, "the fixture's own shape has to fit inside the size under test");
  return JSON.stringify({ ...base, padding: "x".repeat(room) });
}

test("a usage cache of exactly the byte cap is read, and one byte more is not", () => {
  const held = scratch();
  try {
    held.writeSequence(sequence([1], 1));

    held.writeRaw(usageOfExactly(MAX_USAGE_FILE_BYTES));
    const atCap = readUsage({ root: held.root });
    assert.ok(atCap.available, "the cap is the largest file this reader will open, not the first it refuses");
    assert.equal(atCap.accounts.length, 1);

    held.writeRaw(usageOfExactly(MAX_USAGE_FILE_BYTES + 1));
    assert.deepEqual(readUsage({ root: held.root }), { available: false, reason: "oversized" });
  } finally {
    held.cleanup();
  }
});

test("an unusable sequence file degrades the labels and leaves the numbers standing", () => {
  const held = scratch();
  try {
    held.writeUsage({ schemaVersion: 2, accounts: { "1": account() } });
    // No sequence.json at all, the shape a fresh or half-installed claude-swap leaves behind.

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts[0].email, null);
    assert.equal(reading.accounts[0].organizationName, null);
    assert.equal(reading.accounts[0].active, false);
    assert.equal(reading.accounts[0].fiveHour?.pct, 4);
  } finally {
    held.cleanup();
  }
});

test("wrong-shaped fields contribute nothing and the account count is capped", () => {
  const held = scratch();
  try {
    const accounts: Record<string, unknown> = {
      notANumber: account(),
      "9": account({
        fetchedAt: "not a number",
        consecutiveFailures: null,
        lastGood: {
          five_hour: { pct: "46" },
          seven_day: null,
          spend: { currency: "USD" },
          scoped: [{ pct: 10 }, { name: "Fable" }, { name: "Opus", pct: 1e999 }],
        },
      }),
    };
    for (let number = 10; number < 10 + MAX_USAGE_ACCOUNTS + 5; number += 1) {
      accounts[String(number)] = account();
    }
    held.writeUsage({ schemaVersion: 2, accounts });
    held.writeSequence(sequence([9], 9));

    const reading = readUsage({ root: held.root });
    assert.ok(reading.available);
    assert.equal(reading.accounts.length, MAX_USAGE_ACCOUNTS);
    const [first] = reading.accounts;
    assert.equal(first.number, 9, "a non-numeric key is not an account");
    assert.equal(first.fetchedAt, null);
    assert.equal(first.consecutiveFailures, 0);
    assert.equal(first.fiveHour, null, "a pct that is not a number is not a window");
    assert.equal(first.spend, null);
    assert.deepEqual(first.scoped, [], "a scoped row needs both a name and a finite pct");
  } finally {
    held.cleanup();
  }
});

test("the reader opens the two allowlisted files and nothing else", () => {
  const opened: string[] = [];
  const reading = readUsage({
    root: path.join("R"),
    readFile: (file) => {
      opened.push(file);
      if (file.endsWith("usage.json")) {
        return { text: JSON.stringify({ schemaVersion: 2, accounts: { "1": account() } }) };
      }
      return { text: JSON.stringify(sequence([1], 1)) };
    },
  });

  assert.ok(reading.available);
  // The credentials directory beside these two files holds OAuth material. The allowlist is the
  // guarantee that nothing in this module can reach it, and this is what pins the list to two.
  assert.deepEqual(opened, [path.join("R", "cache", "usage.json"), path.join("R", "sequence.json")]);
});

test("a read that is capped or absent never reaches the parser", () => {
  const reading = readUsage({
    root: "R",
    readFile: (file, maxBytes) => {
      assert.equal(maxBytes, MAX_USAGE_FILE_BYTES, "the cap rides on every read");
      return file.endsWith("usage.json") ? { failed: "oversized" } : { failed: "unreadable" };
    },
  });

  assert.deepEqual(reading, { available: false, reason: "oversized" });
});

test("a reader that throws still yields a reading, because a refresh timer has nowhere to catch", () => {
  const reading = readUsage({
    root: "R",
    readFile: () => {
      throw new Error("the shape of a failure this module does not enumerate");
    },
  });

  assert.deepEqual(reading, { available: false, reason: "unreadable" });
});
