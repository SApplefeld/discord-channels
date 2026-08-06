import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARD_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_MIRRORED_PROMPT_LENGTH,
  MAX_THREAD_NAME_LENGTH,
  heartbeat,
  inertMessage,
  inertText,
  renderCard,
  renderMirror,
  renderPermissionRequest,
  threadName,
} from "./render.ts";
import { toView } from "./state.ts";
import type { SessionView } from "./state.ts";
import type { SessionRecord } from "../registry.ts";

const NOW = 1_000_000;

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "0f3c9d21-1111-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    lastTool: "Bash",
    turnCount: 14,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

test("a thread name puts the glyph first and the state last", () => {
  assert.equal(threadName(view(), "working"), "⚙ neo-intake · working");
  assert.equal(threadName(view(), "needs you"), "⏸ neo-intake · needs you");
  assert.equal(threadName(view(), "idle"), "✅ neo-intake · idle");
  assert.equal(threadName(view(), "exited"), "⚠ neo-intake · exited");
});

test("an over-long name is truncated without eating the glyph or the state", () => {
  const name = threadName(view({ name: "x".repeat(400) }), "needs you");

  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} characters`);
  assert.ok(name.startsWith("⏸ "), name);
  assert.ok(name.endsWith(" · needs you"), name);
});

test("a session with no name is still distinguishable in the list", () => {
  assert.equal(threadName(view({ name: null }), "idle"), "✅ session 0f3c9d21 · idle");
});

test("a name of invisible characters falls back rather than rendering an empty title", () => {
  // A local process can announce itself as anything, including a name that renders as nothing at
  // all, and Discord refuses an empty thread name.
  assert.equal(
    threadName(view({ name: "\u200b\u202e\u0000" }), "idle"),
    "✅ session 0f3c9d21 · idle",
  );
});

test("a thread name carries no bidi override or zero-width character", () => {
  const name = threadName(view({ name: "neo\u202eelbisrever\u200b" }), "working");

  assert.equal(name, "⚙ neoelbisrever · working");
});

test("the session ID fallback is neutralized before it is cut", () => {
  // The session ID comes from the same untrusted payload as the name, and a slice taken from raw
  // text can end in the middle of a bidi override.
  const name = threadName(view({ name: null, sessionId: "\u202e0f3c9d21-1111" }), "idle");

  assert.equal(name, "✅ session 0f3c9d21 · idle");
});

test("untrusted text in the card is inert", () => {
  const card = renderCard(
    view({ name: "@everyone **boss**", lastTool: "Bash\u202e`rm -rf`" }),
    "working",
    NOW,
  );

  // The mention survives as text, which allowed_mentions is what neutralizes, but nothing in it
  // can restructure the card around it.
  assert.ok(card.includes("@everyone"), card);
  assert.ok(!card.includes("**boss**"), card);
  assert.ok(!card.includes("\u202e"), card);
  assert.ok(!/`rm -rf`/.test(card), card);
  assert.equal(inertText("a*b_c~d|e`f"), "a\\*b\\_c\\~d\\|e\\`f");
});

test("Discord's chip syntax cannot survive into the card", () => {
  // `<t:...:R>` renders as a live relative timestamp, which would spoof the heartbeat the card
  // exists to carry, and the same brackets carry mentions, channel links, and custom emoji.
  const card = renderCard(
    view({ name: "<t:2000000000:R>", lastTool: "<@123456789012345678>" }),
    "working",
    NOW,
  );

  assert.ok(!/<t:\d+:R>/.test(card), card);
  assert.ok(!/<@\d+>/.test(card), card);
  assert.equal(inertText("<#123>"), "\\<\\#123\\>");
});

test("a card is held below Discord's message limit", () => {
  const card = renderCard(view({ name: "n".repeat(4_000), lastTool: "t".repeat(4_000) }), "idle", NOW);

  assert.ok([...card].length <= MAX_CARD_LENGTH, `${[...card].length} characters`);
});

test("a name is cut on code points, never mid-character", () => {
  // A lone surrogate is not valid UTF-8, and the request body carrying it would be rejected.
  const name = threadName(view({ name: "🛰".repeat(200) }), "working");

  // A lone surrogate does not survive a UTF-8 round trip: it comes back as a replacement character.
  assert.equal(Buffer.from(name, "utf8").toString("utf8"), name);
  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} units`);
  assert.ok(name.endsWith(" · working"));
});

test("the card carries the six named fields and the state", () => {
  const card = renderCard(view({ lastHookAt: NOW - 840_000 }), "working", NOW);

  assert.match(card, /^⚙ \*\*neo-intake\*\* · working$/m);
  assert.match(card, /^Session: 0f3c9d21-1111-4000-8000-000000000001$/m);
  assert.match(card, /^Host: NEO$/m);
  assert.match(card, /^State: working$/m);
  assert.match(card, /^Last tool: Bash$/m);
  assert.match(card, /^Turns: 14$/m);
  assert.match(card, /^Heartbeat: 14m ago$/m);
});

test("an exited card measures its heartbeat from when the session ended", () => {
  const card = renderCard(
    view({ lifecycle: "ended", endedAt: NOW - 7_200_000, lastHookAt: NOW - 9_000_000 }),
    "exited",
    NOW,
  );

  assert.match(card, /^Heartbeat: 2h ago$/m);
});

test("the heartbeat is bucketed so an unchanged session does not spend an edit", () => {
  assert.equal(heartbeat(0), "just now");
  assert.equal(heartbeat(59_999), "just now");
  assert.equal(heartbeat(60_000), "1m ago");
  assert.equal(heartbeat(3_599_000), "59m ago");
  assert.equal(heartbeat(3_600_000), "1h ago");
  assert.equal(heartbeat(24 * 3_600_000), "1d ago");
});

test("neither the view nor the card can carry the process token", () => {
  // processToken is the forgery key for hook posts. A surface that serialized a whole record would
  // publish it into a Discord channel, so the view is built field by field and this is the pin.
  const record: SessionRecord = {
    sessionId: "session-a",
    processToken: "5f0c2e4a-0000-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    toolCount: 3,
    turnCount: 1,
    startedAt: NOW,
    lastHookAt: NOW,
    lastRelayAt: null,
    endedAt: null,
  };

  const narrowed = toView(record);

  assert.ok(!("processToken" in narrowed), Object.keys(narrowed).join(", "));
  assert.ok(!JSON.stringify(narrowed).includes(record.processToken));
  assert.ok(!renderCard(narrowed, "working", NOW).includes(record.processToken));
});

test("a message keeps its markdown and its line structure", () => {
  // A reply is prose the operator reads. Escaping it the way a card is escaped would put
  // backslashes through every code fence and list marker for no gain: mentions are already inert,
  // because the transport sends allowed_mentions with an empty parse list on every write.
  const reply = "Done:\n\n- **two** files changed\n- `npm test` is green";
  assert.equal(inertMessage(reply), reply);
});

test("a message is stripped of the characters that reorder or hide text", () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const bom = String.fromCharCode(0xfeff);
  assert.equal(
    inertMessage(`a${zeroWidth}b${rightToLeftOverride}c${bom}`),
    "abc",
    "the invisible class has no use in a reply and can hide what one says",
  );
});

test("a message is cut to a length Discord will accept", () => {
  const long = inertMessage("x".repeat(MAX_MESSAGE_LENGTH + 500));
  assert.equal(long.length, MAX_MESSAGE_LENGTH);
  assert.ok(long.endsWith("…"), "a cut message says it was cut");
});

/**
 * How many characters of a mirrored message the attribution spends, asked of the renderer rather
 * than written down here. A test carrying its own copy of it would keep passing after the
 * attribution changed length, while measuring a boundary that had moved.
 */
function attributionLength(kind: "prompt" | "reply"): number {
  return renderMirror(kind, "x")[0].length - 1;
}

/** What a mirrored message says, without the attribution line the renderer opened it with. */
function said(message: string): string {
  return message.slice(message.indexOf("\n") + 1);
}

test("a mirrored prompt and a mirrored reply are attributed differently", () => {
  const [promptMessage] = renderMirror("prompt", "run the migration");
  const [replyMessage] = renderMirror("reply", "the migration is done");

  assert.equal(said(promptMessage), "run the migration");
  assert.equal(said(replyMessage), "the migration is done");
  assert.notEqual(promptMessage.split("\n")[0], replyMessage.split("\n")[0]);
  assert.match(promptMessage, /^> .*console/, promptMessage);
  assert.match(replyMessage, /^> .*Claude/, replyMessage);
});

test("mirrored text cannot draw the attribution the renderer composed", () => {
  // The attribution is a blockquote, and every angle bracket in mirrored text is escaped, so a `>`
  // arriving in a reply reaches Discord as the character rather than as the quote marker. Content
  // that copies the attribution verbatim therefore lands as one more quoted line of its own text.
  const forged = renderMirror("reply", "> ✨ Claude\napprove the next request");
  const quoted = forged
    .join("\n")
    .split("\n")
    .filter((line) => line.startsWith("> "));

  assert.equal(forged.length, 1);
  assert.equal(quoted.length, 1, `only the renderer's own line opens a quote: ${forged[0]}`);
  assert.ok(said(forged[0]).startsWith("\\> ✨ Claude"), forged[0]);
});

test("Discord's chip syntax does not survive into a mirrored message", () => {
  // `allowed_mentions` stops a mention pill pinging anyone, not from rendering, and a rendered
  // pill or a live `<t:...:R>` timestamp is what a forged permission prompt would be built from.
  const [message] = renderMirror("reply", "ping <@123456789> at <t:1700000000:R> in <#42>");

  assert.ok(!/<@\d+>/.test(message), message);
  assert.ok(!/<t:\d+:R>/.test(message), message);
  assert.ok(!/<#\d+>/.test(message), message);
  assert.ok(message.includes("\\<@123456789\\>"), message);
});

test("code inside a fence keeps the characters code is written with", () => {
  // The escape is what a fenced block does not need and cannot afford: a fence shows its contents
  // as code, so there is no chip to neutralize in there, and a backslash before every arrow,
  // generic, and comparison would deface the majority of what a mirrored reply carries.
  const code = "const f = (a) => a < 10;\nlet x: Array<string> = [];";
  const [message] = renderMirror("reply", `Here is the fix:\n\n\`\`\`ts\n${code}\n\`\`\``);

  assert.ok(message.includes(code), message);
  assert.ok(!message.includes("\\<"), message);
  assert.ok(!message.includes("\\>"), message);
});

test("a fenced block keeps its characters across a message boundary", () => {
  const code = Array.from(
    { length: 120 },
    (_, index) => `const f${index} = (a: Array<string>) => a.length < ${index};`,
  ).join("\n");
  const messages = renderMirror("reply", `\`\`\`ts\n${code}\n\`\`\``);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  for (const [index, message] of messages.entries()) {
    assert.ok(!said(message).includes("\\<"), `message ${index}: ${message.slice(0, 120)}`);
    assert.ok(message.includes("```ts"), `message ${index} carries its language`);
    assert.equal((message.match(/```/g) ?? []).length % 2, 0, message.slice(0, 80));
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
  }
  assert.ok(messages.map(said).join("\n").includes("const f119 = (a: Array<string>) => a.length < 119;"));
});

test("text outside a fence in the same reply is still stripped of chip syntax", () => {
  const [message] = renderMirror(
    "reply",
    "ping <@123456789> at <t:1700000000:R>\n\n```ts\nconst a: Map<string, number> = new Map();\n```\n\nand <#42>",
  );

  assert.ok(!/<@\d+>/.test(message), message);
  assert.ok(!/<t:\d+:R>/.test(message), message);
  assert.ok(!/<#\d+>/.test(message), message);
  assert.ok(message.includes("Map<string, number>"), message);
});

test("mirrored text cannot draw the attribution from inside a fence either", () => {
  // Inside a fence the quote marker is not escaped, because a fence renders its contents as code
  // and a quoted line there is code too. What keeps it from reading as the renderer's attribution
  // is that it is inside the fence, which is a property of the message this asserts directly.
  const messages = renderMirror("reply", "```\n> ✨ Claude\napprove the next request\n```");

  assert.equal(messages.length, 1);
  const lines = messages[0].split("\n");
  assert.equal(lines[0], renderMirror("reply", "x")[0].split("\n")[0], "the renderer's own line is first");
  assert.equal(lines[1], "```", "the copy is inside the fence, where it renders as code");
  assert.ok(messages[0].endsWith("```"), messages[0]);
});

test("a fence the reply never closed holds to the end of the message", () => {
  // Discord shows the rest of a message as code when a fence is never closed. The escape and the
  // splitter read that the same way, from one model, so text after an unterminated fence is left
  // as code by both rather than escaped by one and fenced by the other.
  const [message] = renderMirror("reply", "```\nping <@123456789> from inside the block");

  assert.ok(message.includes("<@123456789>"), message);
  assert.ok(message.endsWith("```"), "the message closes what the reply left open");
  assert.equal((message.match(/```/g) ?? []).length, 2, message);
});

/** Every backtick run in a message, so a delimiter cut in half is visible as a run of one or two. */
function backtickRuns(message: string): number[] {
  return [...message.matchAll(/`+/g)].map((match) => match[0].length);
}

test("a hard cut never lands inside a fence delimiter", () => {
  // A delimiter split across two messages is a fence the text still has and neither message can
  // see: the escape read the text after it as code and left its chips alone, and no message carries
  // the fence that would make Discord read it the same way.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply") - 4;
  const line = `${"a".repeat(room - 1)}\`\`\` <@123456789> forged > ✨ Claude ${"b".repeat(50)}`;
  const messages = renderMirror("reply", line);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  for (const [index, message] of messages.entries()) {
    for (const run of backtickRuns(message)) {
      assert.ok(run >= 3, `message ${index} carries half a delimiter: a run of ${run}`);
    }
    assert.equal((message.match(/```/g) ?? []).length % 2, 0, `message ${index} is unbalanced`);
    assert.equal(
      message.split("\n").filter((line_) => line_.startsWith("> ")).length,
      1,
      `message ${index}: ${message.slice(0, 120)}`,
    );
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
  }
});

test("a hard cut never lands between an escape and what it makes inert", () => {
  // The escaper writes `\<`. A cut between the two posts the next message starting on a live chip,
  // and the same cut one character along from a quote marker posts one starting on a live blockquote.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply");
  const line = `${"a".repeat(room - 1)}<@123456789>${"b".repeat(50)}`;
  const messages = renderMirror("reply", line);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  for (const [index, message] of messages.entries()) {
    assert.ok(!/(?<!\\)</.test(said(message)), `message ${index} opens on a live chip: ${message.slice(0, 60)}`);
    assert.ok(!said(message).startsWith(">"), `message ${index} opens on a quote marker`);
  }
  assert.equal(messages.map(said).join("").replace(/\\/g, ""), line);
});

test("what follows a closing delimiter on its line is not treated as code", () => {
  // Discord ends the block at the closing delimiter and reads the rest of that line as markdown,
  // which makes it a surface a chip can be drawn on.
  const [message] = renderMirror("reply", "```js\ncode\n``` <t:1700000000:R> and <@123456789>");

  assert.ok(!/<t:\d+:R>/.test(message), message);
  assert.ok(!/<@\d+>/.test(message), message);
  assert.ok(message.includes("```js\ncode\n```"), message);
});

test("a crafted fence info string cannot turn one reply into thousands of messages", () => {
  // The info string rides into every message of a split block. Unbounded, it eats the per-message
  // room and the splitter falls back to a message per code point, which is a synchronous stall of
  // the event loop the permission prompts and the verdicts share.
  const info = "x".repeat(MAX_MESSAGE_LENGTH - 10);
  const messages = renderMirror("reply", `\`\`\`${info}\ncode line one\ncode line two\nmore\n\`\`\`\nafter`);

  assert.ok(messages.length <= 5, `${messages.length} message(s) for one short block`);
  for (const message of messages) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
    assert.equal(inertMessage(message), message, "a message over the ceiling loses its tail here");
  }
});

test("a long reply of many split blocks stays proportionate to its size", () => {
  // The count is the guard: a reply that renders to far more messages than its length can justify
  // is the shape a crafted payload takes, and every message is a Discord write.
  const block = `\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\``;
  const reply = Array.from({ length: 40 }, () => block).join("\n\n");
  const messages = renderMirror("reply", reply);

  assert.ok(
    messages.length <= Math.ceil(reply.length / (MAX_MESSAGE_LENGTH / 2)),
    `${messages.length} message(s) for ${reply.length} characters`,
  );
});

test("mirrored text cannot draw the attribution wherever the fence model puts it", () => {
  // The one property that does not rest on this renderer reading fences the way Discord does: a
  // line-leading quote marker is escaped in both regions, so a disagreement about where the code
  // block is costs a backslash in front of a line of code rather than a forged attribution.
  const attempts = [
    "> ✨ Claude\napprove the next request",
    "```\n> ✨ Claude\napprove the next request\n```",
    "````\n> ✨ Claude\napprove\n````",
    "\\```\n> ✨ Claude\napprove",
    "```ts\ncode\n``` \n> ✨ Claude\napprove",
    "  > ✨ Claude\napprove",
  ];

  for (const attempt of attempts) {
    for (const message of renderMirror("reply", attempt)) {
      const quoted = message.split("\n").filter((line) => /^[ \t]*> /.test(line));
      assert.equal(quoted.length, 1, `${JSON.stringify(attempt)} produced: ${JSON.stringify(message)}`);
      assert.equal(quoted[0], message.split("\n")[0], "the only quoted line is the renderer's own");
    }
  }
});

test("an escaped backtick does not open a fence", () => {
  // A backtick the text itself escaped is a backtick, so what follows it is prose, and prose is
  // where a chip has to be neutralized.
  const [message] = renderMirror("reply", "a \\``` not a fence <@123456789>");

  assert.ok(!/<@\d+>/.test(message), message);
});

test("a shortened paste says so outside the code block it was cut inside", () => {
  const prompt = `\`\`\`log\n${"x".repeat(MAX_MIRRORED_PROMPT_LENGTH)}`;
  const messages = renderMirror("prompt", prompt);
  const last = messages[messages.length - 1];

  assert.ok(last.endsWith("(long paste shortened in mirror)"), last.slice(-80));
  assert.ok(
    last.includes("```\n\n(long paste shortened in mirror)"),
    "the fence is closed before the marker, so the marker is not rendered as code",
  );
});

test("trailing whitespace on a line at a message boundary is not preserved", () => {
  // A known limit, stated rather than discovered: the writer trims a message before it posts it, so
  // a message carrying trailing whitespace would arrive as a different string from the one whose
  // length was measured here. In a split code block that whitespace can be meaningful, which is the
  // cost of the trim.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply");
  const messages = renderMirror("reply", `${"a".repeat(room - 2)}  \n${"b".repeat(80)}`);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  assert.ok(messages[0].endsWith("a"), "the boundary lost the trailing spaces");
});

test("a mirrored message keeps the markdown that makes it readable", () => {
  // Escaping a reply the way a card is escaped would put a backslash through every list marker and
  // code fence, which is the whole surface this feature exists to provide.
  const reply = "Done:\n\n- **two** files changed\n- `npm test` is green";

  assert.deepEqual(renderMirror("reply", reply).map(said), [reply]);
});

test("a mirrored message is stripped of the characters that reorder or hide text", () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);

  assert.equal(said(renderMirror("reply", `a${zeroWidth}b${rightToLeftOverride}c`)[0]), "abc");
});

test("a mirrored message exactly at the ceiling does not split, and one character more does", () => {
  // The classic off-by-one: the ceiling covers the attribution too, so a splitter that measured the
  // text alone would post a message Discord refuses at exactly this length.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply");

  const whole = renderMirror("reply", "x".repeat(room));
  assert.equal(whole.length, 1);
  assert.equal(whole[0].length, MAX_MESSAGE_LENGTH);

  const over = renderMirror("reply", "x".repeat(room + 1));
  assert.equal(over.length, 2);
  assert.ok(over.every((message) => message.length <= MAX_MESSAGE_LENGTH));
  assert.equal(over.map(said).join(""), "x".repeat(room + 1));
});

test("a code block spanning a boundary is fenced in both messages, with its language kept", () => {
  const code = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index};`).join("\n");
  const messages = renderMirror("reply", `\`\`\`typescript\n${code}\n\`\`\``);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  for (const [index, message] of messages.entries()) {
    // The language rides across the boundary: a re-opened bare fence renders the same code without
    // its colours, and no fence at all renders it as prose with its indentation collapsed.
    assert.ok(message.includes("```typescript"), `message ${index}: ${message.slice(0, 80)}`);
    // An odd number of delimiters is a message rendering half its code as prose.
    assert.equal((message.match(/```/g) ?? []).length % 2, 0, message.slice(0, 80));
    assert.ok(message.endsWith("```"), `message ${index} closes its fence`);
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
    if (index > 0) {
      assert.ok(said(message).startsWith("```typescript\n"), "a continued block re-opens first");
    }
  }
  assert.ok(messages.map(said).join("\n").includes(`const value119 = 119;`), "the code arrives whole");
});

test("a code fence the reply never closed is closed on the last message", () => {
  const [message] = renderMirror("reply", "here:\n\n```sh\nnpm test");

  assert.ok(message.endsWith("```"), message);
  assert.equal((message.match(/```/g) ?? []).length, 2, message);
});

test("a hard boundary through astral characters never cuts a character in half", () => {
  // A lone surrogate is not valid UTF-8, and the request body carrying one would be rejected.
  const messages = renderMirror("reply", `${"🛰".repeat(2_000)}${"𠜎".repeat(2_000)}`);

  assert.ok(messages.length >= 4, `${messages.length} message(s)`);
  for (const message of messages) {
    assert.equal(Buffer.from(message, "utf8").toString("utf8"), message, "a surrogate was split");
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} units`);
  }
  assert.equal(messages.map(said).join(""), `${"🛰".repeat(2_000)}${"𠜎".repeat(2_000)}`);
});

test("a very long reply arrives whole, in as many messages as it takes", () => {
  // 36,000 characters, the size class of a real measured reply. Nothing about a reply is cut at any
  // length: a reply is what the operator walked away from the keyboard to keep reading.
  const paragraphs = Array.from(
    { length: 200 },
    (_, index) => `Paragraph ${index}. ${"detail ".repeat(24)}`.trim(),
  );
  const reply = paragraphs.join("\n\n");
  assert.ok(reply.length >= 35_000, `${reply.length} characters`);

  const messages = renderMirror("reply", reply);

  assert.ok(messages.length >= 20, `${messages.length} message(s)`);
  for (const message of messages) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
  }
  // Every break in this reply falls between paragraphs, so putting the paragraph separator back at
  // each boundary reproduces the reply exactly: nothing was dropped, reordered, or shortened.
  assert.equal(messages.map(said).join("\n\n"), reply);
});

test("a prompt past the paste cap is shortened and says so; one at the cap is not", () => {
  const atCap = renderMirror("prompt", "x".repeat(MAX_MIRRORED_PROMPT_LENGTH));
  assert.equal(atCap.map(said).join(""), "x".repeat(MAX_MIRRORED_PROMPT_LENGTH));
  assert.ok(!atCap.join("").includes("shortened"), "a prompt at the cap is not marked");

  const overCap = renderMirror("prompt", "x".repeat(MAX_MIRRORED_PROMPT_LENGTH + 1));
  assert.equal(
    overCap.map(said).join(""),
    `${"x".repeat(MAX_MIRRORED_PROMPT_LENGTH)}\n\n(long paste shortened in mirror)`,
  );
});

test("a reply the length of the paste cap is not capped", () => {
  // The cap protects the thread from the operator's own log dumps. It has no business touching a
  // reply, which is the surface the no-truncation rule exists for.
  const reply = "x".repeat(MAX_MIRRORED_PROMPT_LENGTH + 1);
  const messages = renderMirror("reply", reply);

  assert.equal(messages.map(said).join(""), reply);
  assert.ok(!messages.join("").includes("shortened"));
});

test("a mirrored message with nothing visible in it is no message at all", () => {
  assert.deepEqual(renderMirror("reply", "   \n\n  "), []);
  assert.deepEqual(renderMirror("prompt", ""), []);
});

test("every mirrored message survives the writer's own cap untouched", () => {
  // The cross-pin between the splitter and the path that posts what it produced. `inertMessage` is
  // what every posted message goes through, and it cuts at MAX_MESSAGE_LENGTH: a splitter holding
  // its own larger ceiling would have its tail eaten here, and one holding a smaller ceiling would
  // waste messages. The boundary case is what makes this test discriminating, so one message here
  // sits exactly at the ceiling.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply");
  const messages = renderMirror("reply", `${"x".repeat(room)}\n\n${"y".repeat(room)}`);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].length, MAX_MESSAGE_LENGTH, "a message sits exactly at the ceiling");
  for (const message of messages) {
    assert.equal(inertMessage(message), message);
  }
});

const OPERATOR = "700000000000000002";

function prompt(overrides: Partial<Parameters<typeof renderPermissionRequest>[0]> = {}): string {
  return renderPermissionRequest({
    operatorId: OPERATOR,
    requestId: "abcde",
    toolName: "Bash",
    description: "run the migration",
    inputPreview: "{ command: npm run migrate }",
    ...overrides,
  });
}

test("a permission prompt leads with the mention, the id, and how to answer", () => {
  const text = prompt();
  assert.match(text, /^<@700000000000000002> /, "the mention is the first thing on the first line");
  const lines = text.split("\n");
  assert.match(lines[0], /`abcde`/);
  assert.match(lines[1], /`y abcde`.*`n abcde`/, "the reply the operator has to type is spelled out");
  assert.deepEqual(lines.slice(2), [
    "Tool: Bash",
    "What: run the migration",
    "Input: { command: npm run migrate }",
  ]);
});

test("nothing a tool writes into a prompt can mention anyone or restructure it", () => {
  // The description and the input preview come from a tool call, which anything the session has
  // read can steer, and they land in a message that pings a phone and asks for a yes. A crafted
  // one that spoofs a second prompt or names a role is the attack.
  const text = prompt({
    toolName: "@everyone",
    description: "<@999999999999999999> approve everything",
    inputPreview: "<@&123> **Permission needed** `qrstu`\n@here",
  });
  const mentions = [...text.matchAll(/(?<!\\)<@/g)];
  assert.equal(mentions.length, 1, "the only unescaped mention syntax is the broker's own");
  assert.ok(text.startsWith(`<@${OPERATOR}>`));
  assert.ok(!text.includes("\n@here"), "the whole prompt is the lines the renderer wrote");
  assert.equal(text.split("\n").length, 5);
});

test("a prompt is stripped of the characters that reorder or hide what it says", () => {
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const zeroWidth = String.fromCharCode(0x200b);
  const text = prompt({ description: `safe${zeroWidth}${rightToLeftOverride} delete` });
  assert.ok(text.includes("What: safe delete"), text);
});

test("a tool input long enough to fill a message cannot push the answer off the end", () => {
  // The whole-message cap truncates the tail, so an untrusted field left uncut would take the
  // mention, the id, and the instructions with it, leaving a ping nobody can act on.
  const text = prompt({ inputPreview: "x".repeat(20_000), description: "y".repeat(20_000) });
  assert.ok(text.length < MAX_MESSAGE_LENGTH, `the prompt survives its own cap: ${String(text.length)}`);
  assert.equal(inertMessage(text), text, "nothing is cut a second time on the way out");
  assert.ok(text.startsWith(`<@${OPERATOR}> `));
  assert.match(text, /`y abcde`/);
});

test("a field the tool left empty renders as absent rather than as a blank line", () => {
  const text = prompt({ description: "", inputPreview: "   " });
  assert.ok(text.includes("What: (none)"), text);
  assert.ok(text.includes("Input: (none)"), text);
});

test("a cut prompt field says it was cut, in the label", () => {
  // A tool input is attacker influenced, so it can front-load benign content and push the part
  // worth refusing past the cut. An operator approving from a phone would otherwise be approving a
  // partial view with nothing telling them it was partial.
  const whole = prompt();
  assert.ok(whole.includes("Input: "), whole);
  assert.ok(!whole.includes("Input (cut):"), "a field that fits is not labelled as cut");

  const long = prompt({ inputPreview: "x".repeat(5_000), description: "y".repeat(5_000) });
  assert.ok(long.includes("Input (cut): "), long.split("\n")[4]);
  assert.ok(long.includes("What (cut): "), long.split("\n")[3]);
});
