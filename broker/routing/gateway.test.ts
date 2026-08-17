// The two decisions the gateway makes about an arriving message: which ones reach a session, and
// which ones are the system notices this broker's own pins and renames wrote.
//
// The classifier is driven directly rather than through a connected client, and that is what the
// handler is shaped for: it reduces the library's message to facts, asks once, and hands the answer
// to the one thing that answer names. So a decision that is never "deliver" is a message that never
// reaches `inbound.deliver`, and a decision that is never "delete" is a message Discord is never
// asked to remove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageType } from "discord.js";
import {
  classifyMessage,
  createSystemNoticeCleaner,
  createUnexpectedSystemReport,
} from "./gateway.ts";
import type { MessageFacts, SystemNoticeKind } from "./gateway.ts";
import type { CallOutcome } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";

const CHANNEL = "channel-1";
const SELF = "bot-9";
const OPERATOR = "operator-5";

/** The notice Discord writes into the channel when this bot pins: one of the two ever deleted. */
function pinNotice(facts: Partial<MessageFacts> = {}): MessageFacts {
  return {
    channelId: CHANNEL,
    parentId: null,
    inThread: false,
    type: MessageType.ChannelPinnedMessage,
    authorId: SELF,
    selfId: SELF,
    ...facts,
  };
}

test("a pin notice this bot wrote in this host's channel is deleted", () => {
  assert.equal(classifyMessage(pinNotice(), CHANNEL), "delete");
});

test("a pin notice in another host's channel is left alone", () => {
  // Two brokers can share a guild. The channel is what keeps one host's deletes inside its own.
  assert.equal(classifyMessage(pinNotice({ channelId: "channel-2" }), CHANNEL), "drop");
});

test("an ordinary message from this bot in this channel is left alone", () => {
  // The type is what keeps this off a real message. Same channel, same author, and nothing here
  // reads what it says.
  assert.equal(classifyMessage(pinNotice({ type: MessageType.Default }), CHANNEL), "drop");
});

test("a pin notice behind a pin the operator made by hand is left alone", () => {
  assert.equal(classifyMessage(pinNotice({ authorId: OPERATOR }), CHANNEL), "drop");
});

test("a pin notice arriving before the connection knows its own user is left alone", () => {
  // The bot's own id is what the author is compared against, so without it there is no author
  // check to pass and the notice stays.
  assert.equal(classifyMessage(pinNotice({ selfId: null }), CHANNEL), "drop");
});

test("a system message this bot wrote that is not the pin notice is reported, not deleted", () => {
  // The pin is issued on Discord's message-scoped route, which is newer than the notice type this
  // deletes on. If that route ever announced itself as a different type, the cleaner would delete
  // nothing and say nothing, and an absence reads exactly like success. This is what tells them
  // apart, and it is a report rather than a delete because what the type means is not known here.
  assert.equal(classifyMessage(pinNotice({ type: MessageType.ThreadCreated }), CHANNEL), "report");
});

test("an unexpected system message from anyone else, or in another channel, is not reported", () => {
  // The report is about what this broker itself caused. A system message someone else wrote is not
  // evidence about the pin route, and one in another host's channel is not this broker's business.
  assert.equal(
    classifyMessage(pinNotice({ type: MessageType.ThreadCreated, authorId: OPERATOR }), CHANNEL),
    "drop",
  );
  assert.equal(
    classifyMessage(pinNotice({ type: MessageType.ThreadCreated, channelId: "channel-2" }), CHANNEL),
    "drop",
  );
});

test("an unexpected system type is named once, and the naming is bounded", () => {
  const lines: string[] = [];
  const report = createUnexpectedSystemReport((message) => lines.push(message));

  report(MessageType.ThreadCreated);
  report(MessageType.ThreadCreated);
  report(MessageType.ChannelFollowAdd);

  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0] ?? "", new RegExp(String(MessageType.ThreadCreated)));
  assert.match(lines[1] ?? "", new RegExp(String(MessageType.ChannelFollowAdd)));

  // Bounded in count, so a connection meeting many types cannot fill the log with them.
  for (let type = 100; type < 200; type += 1) report(type);
  assert.ok(lines.length <= 16, `named ${String(lines.length)} types`);
});

test("nothing outside a thread is ever delivered, whatever else it is", () => {
  // The dead end. Every shape a parent-channel message can take answers delete or drop, so none of
  // them reaches the inbound route, the sender gate, or the permission verdict reader.
  const outsideAThread: MessageFacts[] = [
    pinNotice(),
    pinNotice({ channelId: "channel-2" }),
    pinNotice({ type: MessageType.Default }),
    pinNotice({ type: MessageType.Default, authorId: OPERATOR }),
    pinNotice({ authorId: OPERATOR }),
    pinNotice({ selfId: null }),
    pinNotice({ type: MessageType.Reply, authorId: OPERATOR, channelId: CHANNEL }),
    pinNotice({ type: MessageType.ThreadCreated }),
  ];

  for (const facts of outsideAThread) {
    assert.notEqual(classifyMessage(facts, CHANNEL), "deliver", JSON.stringify(facts));
  }
});

test("a message in a thread of this host's channel is still delivered", () => {
  const inThread = pinNotice({
    channelId: "thread-3",
    parentId: CHANNEL,
    inThread: true,
    type: MessageType.Default,
    authorId: OPERATOR,
  });

  assert.equal(classifyMessage(inThread, CHANNEL), "deliver");
});

test("a message in a thread of another host's channel is still dropped", () => {
  const inThread = pinNotice({
    channelId: "thread-3",
    parentId: "channel-2",
    inThread: true,
    type: MessageType.Default,
    authorId: OPERATOR,
  });

  assert.equal(classifyMessage(inThread, CHANNEL), "drop");
});

test("a pin notice in a thread is delivered like any message, never deleted", () => {
  // Pins are the channel's, so a notice cannot arrive in a thread. If one did it would be routed as
  // the message it is rather than removed, because the thread path deletes on the rename type and
  // on nothing else.
  const inThread = pinNotice({ channelId: "thread-3", parentId: CHANNEL, inThread: true });

  assert.equal(classifyMessage(inThread, CHANNEL), "deliver");
});

/** The notice Discord writes into a thread when its name changes: the other of the two deleted. */
function renameNotice(facts: Partial<MessageFacts> = {}): MessageFacts {
  return {
    channelId: "thread-3",
    parentId: CHANNEL,
    inThread: true,
    type: MessageType.ChannelNameChange,
    authorId: SELF,
    selfId: SELF,
    ...facts,
  };
}

test("a rename notice this bot wrote in a thread of this host's channel is deleted", () => {
  // Every state flip and every age tick past the dwell window renames the thread, so this is the
  // line the thread would otherwise collect one of per rename.
  assert.equal(classifyMessage(renameNotice(), CHANNEL), "delete");
});

test("a rename notice behind a rename the operator made by hand is dropped, not deleted", () => {
  // Two claims in one, and the drop is the pinned decision. The delete is refused because the
  // rename is not this broker's to undo the trace of, and the deliver is refused because a system
  // message carries no text a session could act on: Discord draws its line from the new name, so
  // delivering it would put words in the operator's mouth that they never typed.
  assert.equal(classifyMessage(renameNotice({ authorId: OPERATOR }), CHANNEL), "drop");
});

test("a rename notice arriving before the connection knows its own user is dropped", () => {
  // The bot's own id is what the author is compared against, so without it there is no author
  // check to pass and the notice stays.
  assert.equal(classifyMessage(renameNotice({ selfId: null }), CHANNEL), "drop");
});

test("a rename notice in a thread of another host's channel is left alone", () => {
  // Two brokers can share a guild, and the thread's parent is what keeps one host's deletes inside
  // its own channel.
  assert.equal(classifyMessage(renameNotice({ parentId: "channel-2" }), CHANNEL), "drop");
});

test("an ordinary message in a thread this host owns is still delivered", () => {
  // The type is what keeps the thread delete off a real message, exactly as it does in the channel.
  assert.equal(
    classifyMessage(renameNotice({ type: MessageType.Default, authorId: OPERATOR }), CHANNEL),
    "deliver",
  );
  assert.equal(classifyMessage(renameNotice({ type: MessageType.Default }), CHANNEL), "deliver");
});

/** A refusal of the moment: the same call is worth making for the next notice. */
function refused(error: string): CallOutcome<null> {
  return { status: "failed", error, rate: NO_RATE_INFO };
}

/** A refusal of the request itself, which is the one that latches its kind off for the run. */
function refusedForGood(error: string): CallOutcome<null> {
  return { status: "failed", error, rate: NO_RATE_INFO, permanent: true };
}

/**
 * The message this call named is gone. Permanent about that identifier and about no other, which is
 * why it carries both flags: the transport cannot resolve the call again, and the cleaner must not
 * read it as Discord refusing the capability.
 */
function alreadyGone(): CallOutcome<null> {
  return { status: "failed", error: "HTTP 404", rate: NO_RATE_INFO, permanent: true, missing: true };
}

function cleanerWith(
  outcomes: () => Promise<CallOutcome<null>>,
  clock: { at: number },
): {
  deleted: { messageId: string; channelId: string | undefined }[];
  lines: string[];
  clean: (
    notice: { kind: SystemNoticeKind; messageId: string; channelId?: string },
  ) => Promise<void>;
} {
  const deleted: { messageId: string; channelId: string | undefined }[] = [];
  const lines: string[] = [];
  const clean = createSystemNoticeCleaner({
    deleteMessage: async ({ messageId, channelId }) => {
      deleted.push({ messageId, channelId });
      return outcomes();
    },
    log: (message) => lines.push(message),
    now: () => clock.at,
  });
  return { deleted, lines, clean };
}

/** A pin notice as the gateway hands one over: the channel is the route's own default. */
function pinAt(messageId: string): { kind: SystemNoticeKind; messageId: string } {
  return { kind: "pin", messageId };
}

test("a refused delete is logged once for the window and never retried", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(
    async () => refused("HTTP 500"),
    clock,
  );

  await clean(pinAt("notice-1"));
  clock.at += 1_000;
  await clean(pinAt("notice-2"));
  clock.at += 1_000;
  await clean(pinAt("notice-3"));

  // One attempt per notice, and no second attempt at any of them: a notice that survives is the
  // channel a broker without this has, which is not worth a write.
  assert.deepEqual(
    deleted.map((call) => call.messageId),
    ["notice-1", "notice-2", "notice-3"],
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /deleting a pin notice was refused: HTTP 500/);
});

test("a refusal past the window is logged again, counting what was held back", async () => {
  const clock = { at: 1_000_000 };
  const { lines, clean } = cleanerWith(async () => refused("HTTP 500"), clock);

  await clean(pinAt("notice-1"));
  await clean(pinAt("notice-2"));
  clock.at += 10 * 60 * 1000;
  await clean(pinAt("notice-3"));

  assert.equal(lines.length, 2);
  assert.match(lines[1], /1 more since the last line/);
});

test("a refused delete names which notice it was, and the thread it lived in is the route's", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(async () => refused("HTTP 500"), clock);

  await clean({ kind: "rename", messageId: "notice-1", channelId: "thread-3" });

  // The kind is in the line because the two notices sit behind different routes, so a host reading
  // one refusal knows which of its writes is leaving a trace.
  assert.deepEqual(deleted, [{ messageId: "notice-1", channelId: "thread-3" }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /deleting a rename notice was refused: HTTP 500/);
});

test("a permanent refusal latches its kind off and leaves the other attempting", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(async () => refusedForGood("HTTP 403"), clock);

  await clean(pinAt("notice-1"));
  await clean(pinAt("notice-2"));
  await clean({ kind: "rename", messageId: "notice-3", channelId: "thread-3" });

  // One request for a kind Discord refuses outright, and the other kind unaffected: the refusal
  // stands for every later pass, and a rename notice arrives on every state flip of every session
  // thread, so the requests a latch saves are the whole invalid-request budget.
  assert.deepEqual(
    deleted.map((call) => call.messageId),
    ["notice-1", "notice-3"],
  );
  const latched = lines.filter((line) => line.includes("rest of this run"));
  assert.deepEqual(
    latched.map((line) => (line.includes("pin") ? "pin" : "rename")),
    ["pin", "rename"],
    `each kind names its own latch once: ${JSON.stringify(lines)}`,
  );
  assert.match(latched[0], /deleting a pin notice was refused: HTTP 403\. No pin notice is cleaned/);
});

test("a notice that is already gone latches nothing, so every other thread is still cleaned", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(async () => alreadyGone(), clock);

  await clean({ kind: "rename", messageId: "notice-1", channelId: "thread-1" });
  await clean({ kind: "rename", messageId: "notice-2", channelId: "thread-2" });

  // A 404 is permanent about the identifier it named and about nothing else. The operator deleting
  // one notice by hand, or a thread going away mid-pass, must not stand the rename cleaner down for
  // every other session thread, which is what reading `permanent` alone would do.
  assert.deepEqual(
    deleted.map((call) => call.messageId),
    ["notice-1", "notice-2"],
  );
  assert.equal(lines.length, 1, `one line per window, not one per notice: ${JSON.stringify(lines)}`);
  assert.doesNotMatch(lines[0], /rest of this run/);
});

test("a refusal of the moment latches nothing, so the next notice is still attempted", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(async () => refused("HTTP 500"), clock);

  await clean(pinAt("notice-1"));
  await clean(pinAt("notice-2"));

  assert.deepEqual(
    deleted.map((call) => call.messageId),
    ["notice-1", "notice-2"],
  );
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /rest of this run/);
});

test("a delete that lands says nothing at all", async () => {
  const clock = { at: 1_000_000 };
  const { deleted, lines, clean } = cleanerWith(
    async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    clock,
  );

  await clean(pinAt("notice-1"));

  // No channel of its own: a pin notice is in the host's configured channel, which is where the
  // delete route already points.
  assert.deepEqual(deleted, [{ messageId: "notice-1", channelId: undefined }]);
  assert.deepEqual(lines, []);
});

test("a delete the transport throws on is reported, not propagated", async () => {
  const clock = { at: 1_000_000 };
  const { lines, clean } = cleanerWith(async () => {
    throw new Error("socket closed");
  }, clock);

  await clean(pinAt("notice-1"));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /socket closed/);
});
