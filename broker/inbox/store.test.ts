import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EXCERPT_CODE_POINTS, findAsk } from "./ask.ts";
import { createInboxStore, loadInboxSnapshot, saveInboxSnapshot } from "./store.ts";
import type { InboxFlag, InboxItem } from "./store.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-inbox-store-"));
}

const MESSAGE_A = "111111111111111111";
const MESSAGE_B = "222222222222222222";

function marked(postedAt: number, excerpt: string, messageId?: string): InboxFlag {
  return messageId === undefined
    ? { source: "marked", postedAt, excerpt }
    : { source: "marked", postedAt, excerpt, messageId };
}

function judged(postedAt: number, needsReply: number, needsAct: number): InboxFlag {
  return {
    source: "judged",
    postedAt,
    scores: { needsReply, needsAct },
    winner: needsReply >= needsAct ? "needs_reply" : "needs_act",
  };
}

test("a reply with an ASK: line opens a marked item carrying the bounded excerpt", () => {
  const store = createInboxStore();
  const excerpt = findAsk(`Done with the sweep.\nASK: ${"x".repeat(300)}`);
  assert.notEqual(excerpt, null);
  assert.equal(store.flag("s1", marked(1000, excerpt ?? "", MESSAGE_A)), true);

  assert.deepEqual(store.items(), [
    {
      sessionId: "s1",
      openedAt: 1000,
      refreshedAt: 1000,
      source: "marked",
      excerpt: "x".repeat(MAX_EXCERPT_CODE_POINTS),
      scores: null,
      winner: null,
      count: 1,
      messageId: MESSAGE_A,
    },
  ]);
});

test("a second flagged reply refreshes the one item and counts it", () => {
  const store = createInboxStore();
  store.flag("s1", marked(1000, "first", MESSAGE_A));
  store.flag("s1", marked(2000, "second"));
  store.flag("s1", judged(3000, 0.9, 0.1));

  const items = store.items();
  assert.equal(items.length, 1, "one item per session, never a second");
  const [item] = items;
  assert.equal(item?.openedAt, 1000);
  assert.equal(item?.refreshedAt, 3000);
  assert.equal(item?.count, 3);
  assert.equal(item?.excerpt, "second");
  // A flag without a message ID leaves the one already held.
  assert.equal(item?.messageId, MESSAGE_A);

  store.flag("s1", { ...marked(4000, "third"), messageId: MESSAGE_B });
  assert.equal(store.items()[0]?.messageId, MESSAGE_B);
});

test("a refresh never moves the last-refresh instant backwards", () => {
  // A judge verdict can return after a newer marked reply; the instant it carries is its post time.
  const store = createInboxStore();
  store.flag("s1", marked(5000, "newer"));
  store.flag("s1", judged(4000, 0.8, 0.2));
  assert.equal(store.items()[0]?.refreshedAt, 5000);
});

test("a flag that arrives out of order counts but never overwrites a newer reading", () => {
  // An older judged flag after a newer marked one: the excerpt stays, the count moves, and the
  // reading is taken because the item held none.
  const store = createInboxStore();
  store.flag("s1", marked(5000, "newer"));
  assert.equal(store.flag("s1", judged(4000, 0.8, 0.2)), true);
  let item = store.items()[0];
  assert.equal(item?.excerpt, "newer");
  assert.equal(item?.count, 2);
  assert.deepEqual(item?.scores, { needsReply: 0.8, needsAct: 0.2 });

  // An older marked flag leaves the newer excerpt.
  store.flag("s1", marked(3000, "older"));
  item = store.items()[0];
  assert.equal(item?.excerpt, "newer");
  assert.equal(item?.count, 3);
  assert.equal(item?.refreshedAt, 5000);

  // An older judged flag leaves the newer reading.
  store.flag("s1", judged(3500, 0.1, 0.9));
  item = store.items()[0];
  assert.deepEqual(item?.scores, { needsReply: 0.8, needsAct: 0.2 });
  assert.equal(item?.winner, "needs_reply");

  // An equal instant is not older, so it replaces.
  store.flag("s1", marked(5000, "same instant"));
  assert.equal(store.items()[0]?.excerpt, "same instant");
});

test("the message ID held is the most recently posted, not the most recently arrived", () => {
  const store = createInboxStore();
  store.flag("s1", marked(5000, "newer", MESSAGE_A));
  store.flag("s1", marked(4000, "older", MESSAGE_B));
  assert.equal(store.items()[0]?.messageId, MESSAGE_A);
  // A first message ID is taken whatever its instant, since the item held none.
  const other = createInboxStore();
  other.flag("s2", marked(5000, "newer"));
  other.flag("s2", marked(4000, "older", MESSAGE_B));
  assert.equal(other.items()[0]?.messageId, MESSAGE_B);
});

test("an older marked flag still upgrades a judged item, taking the excerpt it carries", () => {
  // The upgrade rule outranks the order rule: a marked item without an excerpt is not a shape the
  // snapshot restores.
  const store = createInboxStore();
  store.flag("s1", judged(5000, 0.9, 0.1));
  store.flag("s1", marked(4000, "the session's own word"));
  const item = store.items()[0];
  assert.equal(item?.source, "marked");
  assert.equal(item?.excerpt, "the session's own word");
  assert.equal(item?.refreshedAt, 5000);
});

test("a flag the snapshot could not restore is dropped or normalized before it is held", () => {
  // The loader refuses the whole snapshot on any of these, so an unchecked flag would cost every
  // item on the next boot.
  const store = createInboxStore();
  assert.equal(store.flag("s1", marked(Number.NaN, "when?")), false);
  assert.equal(store.flag("s1", marked(Number.POSITIVE_INFINITY, "when?")), false);
  assert.equal(store.flag("s1", marked(1000, "y".repeat(MAX_EXCERPT_CODE_POINTS + 1))), false);
  assert.equal(store.flag("s1", marked(1000, "zero\u200bwidth")), false);
  assert.equal(store.flag("s1", judged(1000, 1.2, 0)), false);
  assert.deepEqual(store.items(), []);

  // A message ID that is not a snowflake is treated as not supplied: the item still opens.
  assert.equal(store.flag("s1", marked(1000, "open", "../../channels/9")), true);
  assert.equal(store.items()[0]?.messageId, null);
  // A padded one is normalized before it is checked, the way the loader treats it.
  assert.equal(store.flag("s1", marked(2000, "again", ` ${MESSAGE_A} `)), true);
  assert.equal(store.items()[0]?.messageId, MESSAGE_A);
  // And on a refresh, a bad one leaves the held one.
  assert.equal(store.flag("s1", marked(3000, "again", "not-a-snowflake")), true);
  assert.equal(store.items()[0]?.messageId, MESSAGE_A);
  assert.equal(store.items()[0]?.count, 3);
});

test("a judged item upgrades to marked and never back", () => {
  const store = createInboxStore();
  store.flag("s1", judged(1000, 0.2, 0.8));
  assert.equal(store.items()[0]?.source, "judged");
  assert.equal(store.items()[0]?.excerpt, null);

  store.flag("s1", marked(2000, "merge #14?"));
  const upgraded = store.items()[0];
  assert.equal(upgraded?.source, "marked");
  assert.equal(upgraded?.excerpt, "merge #14?");
  // The upgrade keeps the reading already held.
  assert.deepEqual(upgraded?.scores, { needsReply: 0.2, needsAct: 0.8 });
  assert.equal(upgraded?.winner, "needs_act");

  store.flag("s1", judged(3000, 0.9, 0.1));
  const after = store.items()[0];
  assert.equal(after?.source, "marked");
  assert.equal(after?.excerpt, "merge #14?");
  assert.deepEqual(after?.scores, { needsReply: 0.9, needsAct: 0.1 });
  assert.equal(after?.count, 3);
});

test("a clear at or before the last refresh leaves the item, and a later one removes it", () => {
  // Both directions, since a clear that fires on an older prompt silently empties the inbox.
  const store = createInboxStore();
  store.flag("s1", marked(1000, "open"));
  store.flag("s1", marked(2000, "refreshed"));

  assert.equal(store.clear("s1", 1500), false, "earlier than the refresh");
  assert.equal(store.clear("s1", 2000), false, "equal to the refresh");
  assert.equal(store.items().length, 1);

  assert.equal(store.clear("s1", 2001), true, "later than the refresh");
  assert.deepEqual(store.items(), []);
});

test("a flag posted at or before the session's latest prompt is dropped", () => {
  const store = createInboxStore();
  store.clear("s1", 5000);
  // An older prompt arriving later does not lower the instant held.
  store.clear("s1", 3000);

  assert.equal(store.flag("s1", judged(4000, 0.9, 0.1)), false);
  assert.equal(store.flag("s1", judged(5000, 0.9, 0.1)), false);
  assert.deepEqual(store.items(), []);

  assert.equal(store.flag("s1", judged(5001, 0.9, 0.1)), true);
  assert.equal(store.items().length, 1);

  // A dropped flag does not refresh an item that is already open either.
  store.clear("s1", 5001);
  assert.equal(store.items().length, 1, "equal to the refresh leaves it");
  assert.equal(store.flag("s1", marked(5001, "late")), false);
  assert.equal(store.items()[0]?.count, 1);
});

test("a clear with an instant that is not a number leaves the item and records nothing", () => {
  const store = createInboxStore();
  store.flag("s1", marked(1000, "open"));
  assert.equal(store.clear("s1", Number.NaN), false);
  assert.equal(store.items().length, 1);
  // Nothing was recorded: a flag older than the item still refreshes it.
  assert.equal(store.flag("s1", marked(500, "older")), true);
  assert.equal(store.items()[0]?.count, 2);
});

test("an ended session's clear removes its item unconditionally and records the instant", () => {
  const store = createInboxStore();
  store.flag("s1", marked(9000, "merge it"));
  assert.equal(store.clearEnded("s1", 9500), true);
  assert.deepEqual(store.items(), []);
  assert.equal(store.clearEnded("s1", 9500), false);
  // A verdict on a reply posted before the operator's post in the thread opens nothing.
  assert.equal(store.flag("s1", marked(9500, "again")), false);
  assert.equal(store.flag("s1", judged(9000, 0.9, 0.1)), false);
  assert.deepEqual(store.items(), []);
  assert.equal(store.flag("s1", marked(9501, "later")), true);

  // The instant held is the maximum seen, so an older ended-clear removes the item and lowers
  // nothing.
  assert.equal(store.clearEnded("s1", 9200), true);
  assert.equal(store.flag("s1", marked(9400, "late")), false);
});

test("reconcile drops the items of sessions the registry no longer holds", () => {
  const store = createInboxStore();
  store.flag("s1", marked(1000, "a"));
  store.flag("s2", marked(1000, "b"));
  assert.equal(store.reconcile(new Set(["s2"])), true);
  assert.deepEqual(
    store.items().map((item) => item.sessionId),
    ["s2"],
  );
  assert.equal(store.reconcile(new Set(["s2"])), false);
});

test("items read oldest opened first, ties by session ID", () => {
  const store = createInboxStore();
  store.flag("c", marked(2000, "c"));
  store.flag("b", marked(1000, "b"));
  store.flag("a", marked(2000, "a"));
  // A refresh does not reorder: the order is by the instant the item opened.
  store.flag("b", marked(9000, "b again"));
  assert.deepEqual(
    store.items().map((item) => item.sessionId),
    ["b", "a", "c"],
  );
});

test("onChange fires on every change to the item set and on nothing else", () => {
  let changes = 0;
  const store = createInboxStore({ onChange: () => (changes += 1) });
  store.flag("s1", marked(1000, "a"));
  store.flag("s1", marked(2000, "b"));
  store.clear("s1", 1500);
  store.clear("s2", 1500);
  // Dropped as late: s1's prompt instant is 1500.
  store.flag("s1", marked(1500, "late"));
  assert.equal(changes, 2);
  store.clear("s1", 3000);
  assert.equal(changes, 3);
  store.flag("s1", marked(4000, "c"));
  store.clearEnded("s1", 4500);
  store.clearEnded("s1", 4500);
  store.reconcile(new Set());
  assert.equal(changes, 5);
});

test("the items a caller reads are copies it cannot use to change the store", () => {
  const store = createInboxStore();
  store.flag("s1", judged(1000, 0.9, 0.1));
  const [item] = store.items();
  assert.ok(item !== undefined && item.scores !== null);
  item.count = 99;
  item.scores.needsReply = 0;
  assert.equal(store.items()[0]?.count, 1);
  assert.equal(store.items()[0]?.scores?.needsReply, 0.9);
});

const ITEMS: InboxItem[] = [
  {
    sessionId: "s1",
    openedAt: 1000,
    refreshedAt: 2000,
    source: "marked",
    excerpt: "ship it?",
    scores: { needsReply: 0.75, needsAct: 0.25 },
    winner: "needs_reply",
    count: 2,
    messageId: MESSAGE_A,
  },
  {
    sessionId: "s2",
    openedAt: 1500,
    refreshedAt: 1500,
    source: "judged",
    excerpt: null,
    scores: { needsReply: 0, needsAct: 1 },
    winner: "needs_act",
    count: 1,
    messageId: null,
  },
];

test("the inbox survives a round trip through its snapshot", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    saveInboxSnapshot(file, ITEMS);
    const restored = loadInboxSnapshot(file, { liveSessionIds: new Set(["s1", "s2"]) });
    assert.deepEqual(restored, ITEMS);

    // The restored items seed a store that reads them back unchanged.
    assert.deepEqual(createInboxStore({ items: restored }).items(), ITEMS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a restored item whose session did not restore is dropped", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    saveInboxSnapshot(file, ITEMS);
    const said: string[] = [];
    const restored = loadInboxSnapshot(file, {
      liveSessionIds: new Set(["s2"]),
      log: (m) => said.push(m),
    });
    assert.deepEqual(
      restored.map((item) => item.sessionId),
      ["s2"],
    );
    assert.deepEqual(said, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing inbox snapshot is the first boot and says nothing", () => {
  const directory = scratch();
  try {
    const said: string[] = [];
    assert.deepEqual(
      loadInboxSnapshot(path.join(directory, "nothing.json"), {
        liveSessionIds: new Set(["s1"]),
        log: (m) => said.push(m),
      }),
      [],
    );
    assert.deepEqual(said, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable inbox snapshot degrades to empty with one line", () => {
  // A directory where the file should be: the read itself fails with something other than ENOENT.
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    mkdirSync(file);
    const said: string[] = [];
    assert.deepEqual(
      loadInboxSnapshot(file, { liveSessionIds: new Set(["s1"]), log: (m) => said.push(m) }),
      [],
    );
    assert.equal(said.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt, foreign or malformed inbox snapshot degrades to empty rather than refusing to start", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    const live = new Set(["s1", "s2"]);
    const said: string[] = [];
    const cases: { name: string; body: string }[] = [
      { name: "invalid JSON quoting an excerpt", body: '{"items":[{"excerpt":"SECRET-EXCERPT' },
      { name: "wrong version", body: JSON.stringify({ version: 2, items: ITEMS }) },
      { name: "items not an array", body: JSON.stringify({ version: 1, items: {} }) },
    ];
    const malformed: Record<string, unknown>[] = [
      { sessionId: "" },
      { openedAt: Number.NaN },
      { openedAt: 3000 },
      { source: "guessed" },
      { count: 0 },
      { count: 1.5 },
      { scores: { needsReply: 1.2, needsAct: 0 } },
      { scores: { needsReply: -0.1, needsAct: 0 } },
      { winner: "needs_both" },
      { winner: null },
      { messageId: "../../channels/9" },
      { messageId: 111111111111111111 },
      { excerpt: "y".repeat(MAX_EXCERPT_CODE_POINTS + 1) },
      // The invisible class and uncollapsed whitespace: a stored excerpt is cleaned before it is
      // bounded, so one that changes under that cleaning was not written by this module.
      { excerpt: "ship\u200bit?" },
      { excerpt: "\u202eship it?" },
      { excerpt: "ship  it?" },
      { excerpt: 7 },
      { excerpt: undefined },
    ];
    for (const override of malformed) {
      cases.push({
        name: JSON.stringify(override),
        body: JSON.stringify({ version: 1, items: [ITEMS[1], { ...ITEMS[0], ...override }] }),
      });
    }
    cases.push(
      {
        name: "a judged item carrying an excerpt",
        body: JSON.stringify({ version: 1, items: [{ ...ITEMS[1], excerpt: "x" }] }),
      },
      {
        name: "a judged item without a reading",
        body: JSON.stringify({ version: 1, items: [{ ...ITEMS[1], scores: null, winner: null }] }),
      },
      {
        name: "two items for one session",
        body: JSON.stringify({ version: 1, items: [ITEMS[0], ITEMS[0]] }),
      },
    );

    for (const { name, body } of cases) {
      writeFileSync(file, body, "utf8");
      assert.deepEqual(
        loadInboxSnapshot(file, { liveSessionIds: live, log: (m) => said.push(m) }),
        [],
        name,
      );
    }
    assert.equal(said.length, cases.length, "each refusal says why, so the operator can find the file");
    assert.ok(
      said.every((line) => !line.includes("SECRET-EXCERPT")),
      "no refusal line quotes the snapshot's text",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the malformed-item control: the same base items restore when nothing is overridden", () => {
  // Proves the refusals above come from each override and not from a base item the loader rejects.
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    writeFileSync(file, JSON.stringify({ version: 1, items: [ITEMS[1], { ...ITEMS[0] }] }), "utf8");
    assert.equal(loadInboxSnapshot(file, { liveSessionIds: new Set(["s1", "s2"]) }).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a padded message ID is normalized before it is checked", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, items: [{ ...ITEMS[0], messageId: ` ${MESSAGE_A} ` }] }),
      "utf8",
    );
    assert.equal(
      loadInboxSnapshot(file, { liveSessionIds: new Set(["s1"]) })[0]?.messageId,
      MESSAGE_A,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an inbox snapshot write leaves one file rather than a temp file beside it", () => {
  const directory = scratch();
  try {
    const nested = path.join(directory, "nested");
    const file = path.join(nested, "inbox.json");
    saveInboxSnapshot(file, ITEMS);
    saveInboxSnapshot(file, []);

    assert.deepEqual(readdirSync(nested), ["inbox.json"]);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(parsed, { version: 1, items: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an inbox snapshot write that fails throws and leaves no temp file behind", () => {
  // The target path is a directory, so the write lands and the rename over it refuses.
  const directory = scratch();
  try {
    const file = path.join(directory, "inbox.json");
    mkdirSync(file);

    assert.throws(() => saveInboxSnapshot(file, ITEMS));
    assert.deepEqual(readdirSync(directory), ["inbox.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
