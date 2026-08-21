import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLYPHS,
  MAX_BLOCK_WIDTH,
  MAX_CARD_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_MIRRORED_PROMPT_LENGTH,
  MAX_THREAD_NAME_LENGTH,
  MAX_TOOL_INPUT_PREVIEW,
  TITLE_GLYPHS,
  appendNarration,
  heartbeat,
  inertField,
  inertMessage,
  inertText,
  renderAnswer,
  renderCard,
  renderMirror,
  renderModelChange,
  renderPermissionRequest,
  renderQuestionNotice,
  renderTaskNotice,
  span,
  tableParses,
  tableRowsDrawn,
  threadName,
} from "./render.ts";
import type { AskedOption, AskedQuestion } from "./render.ts";
import { MAX_FIELD_LENGTH } from "../sanitize.ts";
import { toView } from "./state.ts";
import type { SessionView } from "./state.ts";
import type { BackgroundTask, SessionRecord } from "../registry.ts";

const NOW = 1_000_000;

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "0f3c9d21-1111-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    lastTool: "Bash",
    lastToolInput: null,
    turnCount: 14,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    blocked: false,
    lifecycle: "live",
    model: null,
    openingModel: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
    ...overrides,
  };
}

/**
 * Every line a card draws inside a fence, across every block it carries. The title and the block
 * headers are the only lines outside one, so a card that stopped fencing a block fails here rather
 * than in whichever assertion noticed.
 */
function bodyOf(card: string): string[] {
  const lines = card.split("\n");
  assert.equal(lines[2], "```", card);
  assert.equal(lines.at(-1), "```", card);
  const blocks = blocksOf(card);
  return [...blocks.fields, ...(blocks.goal ?? []), ...(blocks.tool ?? []), ...(blocks.tasks ?? [])];
}

/**
 * A card's blocks: the labelled fields every card carries, and the three a card draws only when it
 * has something to put in them, each null when it is left out. `order` is the section headers in the
 * order the card draws them, so a reordering or a lost header fails here rather than in whichever
 * assertion noticed.
 *
 * Read by walking the fences rather than by counting them: every block but the fields is optional,
 * so a fixed part count would describe one card's shape and no other. A header is the last line
 * above the fence it heads, which is also what pins that a header carries no blank line of its own.
 */
function blocksOf(card: string): {
  order: string[];
  fields: string[];
  goal: string[] | null;
  tasks: string[] | null;
  tool: string[] | null;
} {
  const parts = card.split("```");
  assert.equal(parts.length % 2, 1, `a fence the card never closed: ${card}`);
  const headers: string[] = [];
  const bodies: string[][] = [];
  for (let index = 1; index < parts.length; index += 2) {
    headers.push((parts[index - 1].split("\n").filter((line) => line !== "").at(-1) ?? "").trim());
    bodies.push(parts[index].split("\n").filter((line) => line !== ""));
  }
  const at = (header: string): string[] | null => {
    const index = headers.indexOf(header);
    return index === -1 ? null : bodies[index];
  };
  return {
    order: headers.slice(1),
    fields: bodies[0],
    goal: at("### Goal"),
    tasks: at("### Tasks"),
    tool: at("### Tool"),
  };
}

/**
 * Asserts that the only lines of a card carrying a backtick are the delimiters of the blocks it
 * draws, two to a block. Counted off the blocks the card actually has rather than a fixed number,
 * since every block but the fields is drawn only when there is something to put in it, and what the
 * assertion pins either way is that no field composed a delimiter of its own.
 */
function assertOnlyFenceBackticks(card: string): void {
  const drawn = card.split("\n").filter((line) => line.includes("`"));
  const blocks = blocksOf(card).order.length + 1;
  assert.deepEqual(
    drawn,
    Array.from({ length: 2 * blocks }, () => "```"),
    `only the ${String(blocks)} blocks' delimiters carry a backtick: ${card}`,
  );
}

/** The tasks block, on a card that is expected to draw one. */
function tasksOf(card: string): string[] {
  const tasks = blocksOf(card).tasks;
  assert.ok(tasks !== null, `the card draws no tasks block: ${card}`);
  return tasks;
}

/** The tool block, on a card that is expected to draw one. */
function toolOf(card: string): string[] {
  const tool = blocksOf(card).tool;
  assert.ok(tool !== null, `the card draws no tool block: ${card}`);
  return tool;
}

/**
 * The tool block read back as the one value it draws. The block fills its lines to the width rather
 * than breaking on spaces, so the lines rejoin with nothing between them.
 */
function toolValue(card: string): string {
  return toolOf(card).join("");
}

/** The value drawn beside a label in the field block, without the padding that aligns it. */
function value(card: string, label: string): string {
  const line = blocksOf(card).fields.find((text) => text.startsWith(`${label} `)) ?? "";
  return line.slice(label.length).trimStart();
}

test("the downgrade marker stands on every render, not only the one the change landed on", () => {
  // The cost of a forced downgrade is duration rather than the instant: an oversight thread that
  // drops model at hour one runs degraded for every hour after, so the card carries the marker for
  // as long as the session stays below the model it opened with. Rendered twice, with the context
  // moved between them the way a later poll moves it, because a marker that only appeared on the
  // pass the change arrived on would look identical to this at the moment of the change.
  const downgraded = view({
    model: "claude-opus-4-8",
    openingModel: "claude-fable-5",
    contextTokens: 61_380,
    downgrade: {
      cause: "refusal",
      originalModel: "claude-fable-5",
      fallbackModel: "claude-opus-4-8",
      category: "cyber",
      choice: null,
    },
  });

  // Two rows rather than one sentence, because the block is a fixed width: what a session came
  // down from, and why, does not fit beside the model it is running, and a row cut to fit would
  // drop exactly the part that says the session is degraded.
  const marked = (card: string): void => {
    assert.ok(value(card, "Model").startsWith("⚠ claude-opus-4-8"), card);
    assert.equal(value(card, "Down from"), "claude-fable-5 · flagged cyber", card);
  };
  marked(renderCard(downgraded, "working", NOW));
  marked(renderCard({ ...downgraded, contextTokens: 120_000 }, "working", NOW));

  // Returning to the opening model clears it, which is how the operator confirms from the thread
  // that a manual switch-back took effect.
  const restored = renderCard(
    { ...downgraded, model: "claude-fable-5", downgrade: null },
    "working",
    NOW,
  );
  assert.equal(value(restored, "Model"), "claude-fable-5");
  assert.equal(value(restored, "Context"), "61k", "the context size has a row of its own");
  assert.ok(!restored.includes("Down from"), restored);
});

test("a thread name puts the glyph first and the title state last", () => {
  assert.equal(threadName(view(), "working"), "⚙ neo-intake · active");
  assert.equal(threadName(view(), "idle"), "⚙ neo-intake · active");
  assert.equal(threadName(view(), "needs you"), "⏹ neo-intake · needs you");
  assert.equal(threadName(view(), "blocked"), "⛔ neo-intake · blocked");
  assert.equal(threadName(view(), "exited"), "⚠ neo-intake · exited");
});

test("the title's own vocabulary is pinned here", () => {
  // A rename writes a notice into the thread that nothing can remove, so the set of states worth a
  // title is a deliberate list rather than the card's, and its glyphs are written out as literals.
  assert.deepEqual(TITLE_GLYPHS, {
    active: "⚙",
    "needs you": "⏹",
    blocked: "⛔",
    exited: "⚠",
  });
});

test("the card draws one glyph per state, and the five are pinned here", () => {
  // The card is the surface carrying the whole state, so it is the one with five glyphs. They are
  // written out as literals here so a change to one is a change to this test.
  assert.deepEqual(GLYPHS, {
    working: "⚙",
    "needs you": "⏹",
    blocked: "⛔",
    idle: "⏸",
    exited: "⚠",
  });

  for (const state of ["working", "needs you", "blocked", "idle", "exited"] as const) {
    assert.ok(renderCard(view(), state, NOW).startsWith(`${GLYPHS[state]} `), state);
  }
});

test("a session going quiet does not change its thread name", () => {
  // Every rename writes a notice into the thread that nothing can remove, so working and idle are
  // one title state and the difference between them is read off the card.
  const quiet = view();

  assert.equal(threadName(quiet, "working"), threadName(quiet, "idle"));
  assert.equal(threadName(quiet, "idle"), `${TITLE_GLYPHS.active} neo-intake · active`);
});

test("an over-long name is truncated without eating the glyph or the state", () => {
  const name = threadName(view({ name: "x".repeat(400) }), "needs you");

  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} characters`);
  assert.ok(name.startsWith(`${TITLE_GLYPHS["needs you"]} `), name);
  assert.ok(name.endsWith(" · needs you"), name);
});

test("a session with no name is still distinguishable in the list", () => {
  assert.equal(
    threadName(view({ name: null }), "idle"),
    `${TITLE_GLYPHS.active} session 0f3c9d21 · active`,
  );
});

test("a name of invisible characters falls back rather than rendering an empty title", () => {
  // A local process can announce itself as anything, including a name that renders as nothing at
  // all, and Discord refuses an empty thread name.
  assert.equal(
    threadName(view({ name: "\u200b\u202e\u0000" }), "idle"),
    `${TITLE_GLYPHS.active} session 0f3c9d21 · active`,
  );
});

test("a thread name carries no bidi override or zero-width character", () => {
  const name = threadName(view({ name: "neo\u202eelbisrever\u200b" }), "working");

  assert.equal(name, "⚙ neoelbisrever · active");
});

test("the session ID fallback is neutralized before it is cut", () => {
  // The session ID comes from the same untrusted payload as the name, and a slice taken from raw
  // text can end in the middle of a bidi override.
  const name = threadName(view({ name: null, sessionId: "\u202e0f3c9d21-1111" }), "idle");

  assert.equal(name, `${TITLE_GLYPHS.active} session 0f3c9d21 · active`);
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

test("Discord's chip syntax cannot render anywhere on the card", () => {
  // `<t:...:R>` renders as a live relative timestamp, which would spoof the heartbeat the card
  // exists to carry, and the same brackets carry mentions, channel links, and custom emoji. The
  // title line and the heading under it are live markdown, so the syntax is escaped out of both; the
  // body is inside a fence, where Discord resolves no chip at all, so the syntax survives as the
  // characters it is, which is what the operator should see a tool called `<@...>` as.
  const card = renderCard(
    view({ name: "<t:2000000000:R>", lastTool: "<@123456789012345678>" }),
    "working",
    NOW,
  );

  assert.ok(!/<t:\d+:R>/.test(card.split("\n").slice(0, 2).join("\n")), card);
  assert.deepEqual(toolOf(card), ["<@123456789012345678>"], "characters inside the fence");
  assert.equal(inertText("<#123>"), "\\<\\#123\\>");
});

test("a card is held below Discord's message limit", () => {
  const card = renderCard(view({ name: "n".repeat(4_000), lastTool: "t".repeat(4_000) }), "idle", NOW);

  assert.ok([...card].length <= MAX_CARD_LENGTH, `${[...card].length} characters`);
});

test("a long tool name cannot push the heartbeat off the card", () => {
  // The whole-card cap cuts the tail, and the tail is where the field the card exists to carry
  // lives. So holding the card under the ceiling is not enough on its own: the untrusted fields
  // above it have to be bounded individually, or a session announcing a tool name of maximum
  // length spends the whole card on it and the operator's glance answers nothing. Driven at the
  // real wire cap, MAX_FIELD_LENGTH, which is what `clean` holds every payload string to, and in
  // backticks, the character the block escape doubles, which is the widest a field of that length
  // can render.
  const card = renderCard(
    view({
      sessionId: "`".repeat(MAX_FIELD_LENGTH),
      name: "`".repeat(MAX_FIELD_LENGTH),
      host: "`".repeat(MAX_FIELD_LENGTH),
      lastTool: "`".repeat(MAX_FIELD_LENGTH),
      lastToolInput: "`".repeat(MAX_FIELD_LENGTH),
      lastHookAt: NOW - 840_000,
    }),
    "working",
    NOW,
  );

  assert.ok([...card].length <= MAX_CARD_LENGTH, `${[...card].length} characters`);
  assert.equal(value(card, "Heartbeat"), "14m ago");
  // The tool has a block of its own now, and it is bounded there rather than by the row it used to
  // share: the name is held to a line and the preview keeps its own budget beside it.
  assert.ok(toolOf(card).length <= 4, toolOf(card).join("\n"));
});

test("a name is cut on code points, never mid-character", () => {
  // A lone surrogate is not valid UTF-8, and the request body carrying it would be rejected.
  const name = threadName(view({ name: "🛰".repeat(200) }), "working");

  // A lone surrogate does not survive a UTF-8 round trip: it comes back as a replacement character.
  assert.equal(Buffer.from(name, "utf8").toString("utf8"), name);
  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} units`);
  assert.ok(name.endsWith(" · active"));
});

test("the card carries the named fields, the state, and its tool block", () => {
  const card = renderCard(view({ lastHookAt: NOW - 840_000, contextTokens: 737_000 }), "working", NOW);

  // The title line, the heading, and the section headers are the lines outside a fence, since
  // Discord renders no markdown at all inside a block; every field is a row of the first block. The
  // host leads, because it is the first thing to orient on.
  assert.equal(card.split("\n")[0], "⚙ **neo-intake** · working");
  assert.deepEqual(blocksOf(card).fields, [
    "Host      NEO",
    "Session   0f3c9d21",
    "State     working",
    "Context   737k",
    "Heartbeat 14m ago",
  ]);
  assert.deepEqual(toolOf(card), ["Bash"], "the tool is a block of its own");
  // Every value starts in the same column, which is the whole reason the body is fenced: a phone
  // draws the block in a monospace font, so a padded label column is what makes the fields scannable.
  const columns = new Set(
    ["Session", "Host", "State", "Context", "Heartbeat"].map((label) => {
      const line = blocksOf(card).fields.find((text) => text.startsWith(`${label} `)) ?? "";
      return line.length - value(card, label).length;
    }),
  );
  assert.equal(columns.size, 1, blocksOf(card).fields.join("\n"));
});

test("the card's title is a heading, and its section headers a smaller one against the block above", () => {
  // The message's first line is drawn inline beside the bot's name, where it reads as chrome rather
  // than as the card's own heading, so a channel of cards scrolls as one run of text with nothing to
  // pick a card out by. The title is repeated at the largest heading size on a line of its own, and
  // the section headers take a smaller one, so the title and its sections read as different ranks.
  const card = renderCard(
    view({ goal: "ship the pin reconcile", backgroundTasks: [agent("S6")] }),
    "working",
    NOW,
  );
  const lines = card.split("\n");

  assert.equal(lines[0], "⚙ **neo-intake** · working · 1 task");
  assert.equal(lines[1], "# ⚙ neo-intake · working · 1 task");
  assert.equal(lines[2], "```", "the heading sits directly against the block it heads");
  for (const header of ["### Goal", "### Tool", "### Tasks"]) {
    const at = lines.indexOf(header);
    assert.ok(at > 0, `${header} is drawn: ${card}`);
    // Discord draws its own air around a fenced block, so a header carries none of its own on
    // either side of it.
    assert.equal(lines[at - 1], "```", `a blank line above ${header}: ${card}`);
    assert.equal(lines[at + 1], "```", `a blank line below ${header}: ${card}`);
  }
});

test("the tool leads the tasks, and the goal leads both", () => {
  // A session usually has a tool and rarely has tasks, so the sparse block does not lead. The goal
  // keeps its place directly under the fields, which the new order leaves untouched.
  const card = renderCard(
    view({ goal: "ship the pin reconcile", backgroundTasks: [agent("S6")] }),
    "working",
    NOW,
  );

  assert.ok(card.indexOf("### Goal") > card.indexOf("Heartbeat"), card);
  assert.ok(card.indexOf("### Tool") > card.indexOf("### Goal"), card);
  assert.ok(card.indexOf("### Tasks") > card.indexOf("### Tool"), card);
});

test("a section with nothing to show is left out, header and block together", () => {
  const quiet = renderCard(view({ lastTool: null, lastToolInput: null }), "working", NOW);
  const tooled = renderCard(view(), "working", NOW);

  assert.ok(!quiet.includes("### Tool"), quiet);
  assert.ok(!quiet.includes("### Tasks"), quiet);
  assert.ok(!quiet.includes("None"), quiet);
  // A session running a tool and waiting on nothing draws the one block it has something for.
  assert.ok(tooled.includes("### Tool"), tooled);
  assert.ok(!tooled.includes("### Tasks"), tooled);
});

test("the card's body stays inside the width bound at its widest fields", () => {
  // A phone scrolls a code block sideways rather than wrapping it, so one line past the bound costs
  // a drag across the whole card. Driven at the widest a session can make it: a tool preview at its
  // own budget, a model line carrying a downgrade and a context size, and a full fan-out roster.
  const card = renderCard(
    view({
      lastTool: "Bash",
      lastToolInput: "x".repeat(MAX_TOOL_INPUT_PREVIEW),
      model: "claude-opus-4-8",
      openingModel: "claude-fable-5",
      contextTokens: 348_000,
      downgrade: {
        cause: "refusal",
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        category: "cyber",
        choice: null,
      },
      backgroundTasks: Array.from({ length: 12 }, (_unused, index) =>
        agent(`task-${index}`, { since: NOW - (index + 1) * 60_000 }),
      ),
    }),
    "working",
    NOW,
  );

  for (const line of bodyOf(card)) {
    assert.ok(
      [...line].length <= MAX_BLOCK_WIDTH,
      `${[...line].length} characters is past the ${MAX_BLOCK_WIDTH} bound: ${line}`,
    );
  }
});

test("a session under a goal says what it is trying to finish, and one without renders unchanged", () => {
  // The goal has a block of its own rather than a row of the field block: it is a sentence the
  // operator wrote, and the room a label column leaves at this width is a third of a line.
  const working = renderCard(view({ goal: "ship the pin reconcile" }), "working", NOW);

  assert.deepEqual(blocksOf(working).goal, ["ship the pin reconcile"]);
  assert.match(working, /^### Goal$/m, "the header is outside the fence, where the heading renders");
  // The block that comes and goes is the one whose absence has to be exact: a session under no goal
  // draws the card it drew before this block existed, rather than an empty block of its own.
  assert.equal(blocksOf(renderCard(view(), "working", NOW)).goal, null);
  assert.equal(
    renderCard(view(), "working", NOW),
    renderCard(view({ goal: null }), "working", NOW),
  );
});

test("the goal is dropped the moment the session reads idle or exited", () => {
  // Whether a goal has been met is not observable: one that clears on completion writes nothing, so
  // there is no line to read the end off. What stands in for it is the session stopping, since a
  // goal being met is precisely what lets it stop. A card carrying a finished goal indefinitely is
  // worse than no goal line at all, because it reads as current.
  const under = view({ goal: "ship the pin reconcile" });

  assert.deepEqual(blocksOf(renderCard(under, "working", NOW)).goal, ["ship the pin reconcile"]);
  assert.deepEqual(
    blocksOf(renderCard({ ...under, needsAttention: true }, "needs you", NOW)).goal,
    ["ship the pin reconcile"],
    "a session waiting on a person has not finished what it is doing",
  );
  assert.deepEqual(
    blocksOf(renderCard({ ...under, blocked: true }, "blocked", NOW)).goal,
    ["ship the pin reconcile"],
    "and a run stopped on the operator is the case where the goal names what it stopped on",
  );
  assert.equal(blocksOf(renderCard(under, "idle", NOW)).goal, null);
  assert.equal(
    blocksOf(renderCard({ ...under, lifecycle: "ended", endedAt: NOW }, "exited", NOW)).goal,
    null,
  );
});

test("a goal longer than the block is cut rather than wrapped", () => {
  const card = renderCard(view({ goal: `${"g".repeat(200)} and then some` }), "working", NOW);
  const goal = blocksOf(card).goal ?? [];

  assert.equal(goal.length, 1, "one line, however long the operator's sentence is");
  assert.equal([...goal[0]].length, MAX_BLOCK_WIDTH);
  assert.ok(goal[0].endsWith("…"), goal[0]);
});

test("a crafted goal can compose no pill, no chip, no markdown, and no fence delimiter", () => {
  // The goal is operator prose off a transcript, which is untrusted text of the same class as every
  // other field the card draws, and it is drawn inside a fence where none of that syntax renders.
  const card = renderCard(
    view({ goal: "before\nafter ``` **bold** \\` <@123456789012345678>" }),
    "working",
    NOW,
  );
  const goal = blocksOf(card).goal ?? [];

  assert.equal(goal.length, 1);
  assert.doesNotMatch(goal[0], /`/, `no backtick reaches the body: ${goal[0]}`);
  assert.match(goal[0], /beforeafter/, "the newline is stripped, never a line break");
  assert.match(
    renderCard(view({ goal: "<@123456789012345678> at <t:99:R>" }), "working", NOW),
    /<@123456789012345678> at <t:99:R>/,
    "the chip syntax reads as its own characters inside the fence",
  );
  assertOnlyFenceBackticks(card);
});

test("a card carrying a goal, a full roster and its widest fields still fits one message", () => {
  // The goal block is fixed length, so it comes out of the same budget the roster gives way from:
  // a card that could not be trimmed back inside the ceiling is a card Discord refuses, which
  // freezes the thread at whatever it last said.
  const card = renderCard(
    view({
      name: "n".repeat(200),
      goal: "g".repeat(200),
      lastTool: "t".repeat(80),
      lastToolInput: "x".repeat(MAX_TOOL_INPUT_PREVIEW),
      model: "claude-opus-4-8",
      openingModel: "claude-fable-5",
      contextTokens: 348_000,
      downgrade: {
        cause: "refusal",
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        category: "cyber",
        choice: null,
      },
      backgroundTasks: Array.from({ length: 40 }, (_unused, index) =>
        agent(`task-${index}`, {
          since: NOW - (index + 1) * 60_000,
          description: "d".repeat(120),
          agentType: "a".repeat(60),
        }),
      ),
    }),
    "working",
    NOW,
  );

  assert.ok(card.length <= MAX_CARD_LENGTH, `${card.length} characters is past the ceiling`);
  assert.deepEqual(blocksOf(card).goal, [`${"g".repeat(MAX_BLOCK_WIDTH - 1)}…`]);
  // The roster is what gave way, and the goal block is what it gave way for: the two blocks that
  // can grow are pinned against each other here, so a goal block that stopped coming out of the
  // same budget fails rather than quietly costing the card its ceiling.
  assert.ok(
    tasksOf(card).some((line) => /^\+\d+ more$/.test(line)),
    tasksOf(card).join("\n"),
  );
  for (const line of bodyOf(card)) {
    assert.ok([...line].length <= MAX_BLOCK_WIDTH, line);
  }
});

test("a field inside the fence shows its own characters, with no escape a fence would draw", () => {
  // Inside a block Discord renders no markdown and resolves no chip, so nothing there needs the
  // full escape, and applying it would reach the operator as a visible backslash in front of every
  // underscore and asterisk: a real tool name is exactly the string that pays that cost. The title
  // is outside the fence and keeps the full escape, because there the syntax is live.
  const card = renderCard(
    view({
      name: "**loud**",
      host: "**host**",
      lastTool: "mcp__plugin_relay_channel-relay",
      lastToolInput: null,
    }),
    "working",
    NOW,
  );

  assert.deepEqual(toolOf(card), ["mcp__plugin_relay_channel-relay"]);
  assert.equal(value(card, "Host"), "**host**", "the fence shows the asterisks as characters");
  assert.ok(card.split("\n")[0].includes(String.raw`\*\*loud\*\*`), "the title still escapes");
});

test("no crafted field can break out of the fence or compose a body line of its own", () => {
  // A fenced body carries no backtick at all, which is the only bound a crafted field cannot
  // compose around. Escaping one would not do it: a fenced block honors no backslash escape, so an
  // escaped backtick arrives as a backslash and a live backtick, and three of those close the block
  // and put the rest of the card outside it. Replacement is the property that holds. Nothing else
  // is escaped here for the same reason the backtick cannot be, and a backslash therefore draws as
  // itself, which is what makes a Windows path read as the path that was written. The newline dies
  // in the invisible strip, so no field composes a body line of its own.
  const card = renderCard(
    view({
      host: "before\nafter",
      sessionId: "```js-\\`-rest",
      lastTool: "```js",
      lastToolInput: "`".repeat(200),
    }),
    "working",
    NOW,
  );

  assertOnlyFenceBackticks(card);
  for (const line of bodyOf(card)) {
    assert.doesNotMatch(line, /`/, `no backtick inside the body: ${line}`);
  }
  assert.equal(value(card, "Host"), "beforeafter", "the newline is stripped, never a line break");
  // The tool block fills its lines to the width, so a break can land between an escape and the
  // character it makes inert. A backslash left at the end of a line is drawn as a backslash, which
  // is the shape to know about, so it is pinned rather than reasoned about.
  for (const line of toolOf(card)) {
    assert.doesNotMatch(line, /\\$/, `no line ends stranded from what it escapes: ${line}`);
  }
});

test("the tool line carries what the tool was called with, from the record through the view", () => {
  // The whole tail of the chain against one literal: a record's preview, narrowed to a view, drawn
  // on the card. Tested end to end because a card that agreed with itself about a field the view
  // never carried would look exactly like this test passing.
  const record: SessionRecord = {
    sessionId: "session-a",
    processToken: "5f0c2e4a-0000-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    lastToolInput: "npm test",
    toolCount: 3,
    turnCount: 1,
    startedAt: NOW,
    lastHookAt: NOW,
    lastEngagementAt: NOW,
    lastRelayAt: null,
    endedAt: null,
    openingModel: null,
    model: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
  };

  assert.equal(toolValue(renderCard(toView(record), "working", NOW)), "Bash · npm test");
});

test("a tool that supplied nothing previewable renders the name alone, and no tool renders no block", () => {
  assert.equal(toolValue(renderCard(view({ lastToolInput: null }), "working", NOW)), "Bash");
  assert.equal(
    blocksOf(renderCard(view({ lastTool: null, lastToolInput: null }), "working", NOW)).tool,
    null,
    "a session that has run no tool has nothing to head a block with",
  );
  // A preview of nothing but invisible characters neutralizes to an empty string, which renders as
  // no preview rather than as a separator with nothing after it.
  assert.equal(toolValue(renderCard(view({ lastToolInput: "​‮" }), "working", NOW)), "Bash");
});

test("a preview past the block's budget is cut and says so", () => {
  const long = renderCard(view({ lastToolInput: "a".repeat(MAX_TOOL_INPUT_PREVIEW + 1) }), "working", NOW);
  // The marker names the cut rather than leaving it to the ellipsis: a tool input is
  // attacker-influenced text, so it can front-load the harmless part. Its own room comes out of the
  // budget before the preview is cut, so a partial preview can never read as a whole one.
  assert.ok(toolValue(long).endsWith(" (cut)"), toolValue(long));
  assert.ok(toolValue(long).startsWith("Bash · aaaa"), toolValue(long));

  // A preview exactly at its budget renders whole and unmarked; one character more takes the cut
  // and its marker. The budget is the preview's own, not what a row leaves after a label: the value
  // wraps across the block's lines rather than being cut to one of them, which is what a real path
  // needs and what the label column could not give it.
  const exact = renderCard(view({ lastToolInput: "p".repeat(MAX_TOOL_INPUT_PREVIEW) }), "working", NOW);
  assert.equal(toolValue(exact), `Bash · ${"p".repeat(MAX_TOOL_INPUT_PREVIEW)}`);
  assert.ok(toolOf(exact).length > 1, "a preview that long is drawn over several lines");

  // A short preview renders whole, with no marker at all, and on one line.
  const short = renderCard(view({ lastToolInput: "npm test" }), "working", NOW);
  assert.deepEqual(toolOf(short), ["Bash · npm test"]);
});

test("a long tool name cannot squeeze the preview out of the block", () => {
  // Both halves are attacker-influenceable, so a name allowed to fill the block would let a session
  // hide what its tools are called with from the surface the operator glances at. The name is held
  // to a line and the preview keeps its own budget whatever the name spends.
  const card = renderCard(
    view({ lastTool: "t".repeat(120), lastToolInput: "rm -rf / --no-preserve-root" }),
    "working",
    NOW,
  );

  const drawn = toolValue(card);
  assert.ok(drawn.includes(" · rm -rf / --no-preserve-root"), `the preview survives the name: ${drawn}`);
  assert.ok(drawn.startsWith("ttttt"), drawn);
  assert.ok(/t…/.test(drawn), `the name carries its own cut: ${drawn}`);
  for (const line of toolOf(card)) {
    assert.ok([...line].length <= MAX_BLOCK_WIDTH, line);
  }
});

test("Discord's chip syntax in a tool-input preview reads as its characters", () => {
  // The preview is a tool call's own argument, so anything the session read can steer it. It is
  // drawn inside the fence, where Discord resolves no chip and renders no pill, so the syntax
  // reaches the operator as the characters the tool was really called with rather than behind
  // backslashes that halve the preview's budget.
  const card = renderCard(
    view({ lastTool: "Bash", lastToolInput: "<@123456> at <t:99:R>" }),
    "working",
    NOW,
  );

  assert.equal(toolValue(card), "Bash · <@123456> at <t:99:R>");
});

test("eight characters of the session id are eight, however many need escaping", () => {
  // The raw id is sliced before it is neutralized, so eight characters of an id are eight on the
  // card. A fenced field draws a backslash as itself, so these pass through, and what can still
  // change a field's length is the whitespace collapse: sliced after that, two ids differing only
  // past the collapse would draw one prefix on the surface the operator tells threads apart by.
  const first = renderCard(view({ sessionId: String.raw`\\\\aaaa-rest` }), "working", NOW);
  const second = renderCard(view({ sessionId: String.raw`\\\\bbbb-rest` }), "working", NOW);

  assert.equal(value(first, "Session"), String.raw`\\\\aaaa`);
  assert.equal(value(second, "Session"), String.raw`\\\\bbbb`);
  assert.notEqual(value(first, "Session"), value(second, "Session"));
});

test("an exited card measures its heartbeat from when the session ended", () => {
  const card = renderCard(
    view({ lifecycle: "ended", endedAt: NOW - 7_200_000, lastHookAt: NOW - 9_000_000 }),
    "exited",
    NOW,
  );

  assert.equal(value(card, "Heartbeat"), "2h ago");
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
    lastToolInput: "git status",
    toolCount: 3,
    turnCount: 1,
    startedAt: NOW,
    lastHookAt: NOW,
    lastEngagementAt: NOW,
    lastRelayAt: null,
    endedAt: null,
    openingModel: null,
    model: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
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

test("a field with no room left is empty, not a lone cut marker", () => {
  // A suffix can consume the whole width a label had, and a bound of zero has to mean zero: a cut
  // marker drawn there is one character wide and puts the line it sits in over the width that was
  // measured for it. One character of room is the last one that can carry the marker.
  assert.equal(inertField("neo-tail", 0), "");
  assert.equal(inertField("neo-tail", 1), "…");
});

/**
 * How many characters of a mirrored message the attribution spends, asked of the renderer rather
 * than written down here. A test carrying its own copy of it would keep passing after the
 * attribution changed length, while measuring a boundary that had moved.
 */
function attributionLength(kind: "prompt" | "reply"): number {
  return renderMirror(kind, "x")[0].length - 1;
}

/**
 * The same measurement for the reply tool's attribution, which is its own constant and its own
 * length: the glyph there is astral, so it spends two UTF-16 units where a plain one spends one.
 */
function answerAttributionLength(): number {
  return renderAnswer("x")[0].length - 1;
}

/** What a mirrored message says, without the attribution line the renderer opened it with. */
function said(message: string): string {
  return message.slice(message.indexOf("\n") + 1);
}

/**
 * Every line Discord would read as opening a blockquote, leading whitespace tolerated because
 * Discord tolerates it. Matches `>` rather than `> ` so the prompt's `>>>` is counted too, and a
 * near-miss like `>>text` is not silently treated as harmless.
 */
function quoteOpeningLines(message: string): string[] {
  return message.split("\n").filter((line) => /^[ \t]*>/.test(line));
}

test("a mirrored prompt and a mirrored reply are attributed differently", () => {
  const [promptMessage] = renderMirror("prompt", "run the migration");
  const [replyMessage] = renderMirror("reply", "the migration is done");

  assert.equal(said(promptMessage), "run the migration");
  assert.equal(said(replyMessage), "the migration is done");
  assert.notEqual(promptMessage.split("\n")[0], replyMessage.split("\n")[0]);

  // The distinction a reader makes while scrolling is quoted versus not, so it is asserted as that
  // rather than as two different marker strings. `>>>` quotes every line after it in the message,
  // which is what keeps a multi-paragraph paste from arriving half quoted.
  assert.match(promptMessage, /^>>> .*console/, promptMessage);
  assert.match(replyMessage, /^✨ .*Claude/, replyMessage);
  assert.equal(quoteOpeningLines(promptMessage).length, 1, promptMessage);
  assert.equal(quoteOpeningLines(replyMessage).length, 0, replyMessage);
});

test("an interim chunk carries the working attribution, unquoted like a reply", () => {
  // Mid-turn narration is Claude's own text, so it is unquoted like a reply (the quoted block is
  // the one that must stay unforgeable) and marked `working` so a reader scrolling later can tell
  // narration from the turn's final word.
  const [interimMessage] = renderMirror("interim", "reading the failing test first");

  assert.equal(said(interimMessage), "reading the failing test first");
  assert.match(interimMessage, /^✨ Claude · working\n/, interimMessage);
  assert.equal(quoteOpeningLines(interimMessage).length, 0, interimMessage);
  assert.notEqual(
    interimMessage.split("\n")[0],
    renderMirror("reply", "reading the failing test first")[0].split("\n")[0],
    "narration and a final reply must be tellable apart at a glance",
  );
});

test("an interim chunk gets the reply's treatment: uncapped, split whole, chips escaped", () => {
  // One splitter and one escape, exercised through the same machinery a reply uses; a second copy
  // of either would be two readings of where a code fence is. The paste cap belongs to prompts
  // alone: narration is written to be read, like a reply, and is never shortened.
  const long = Array.from({ length: 60 }, (_, index) => `Paragraph ${index}. ${"detail ".repeat(40)}`.trim()).join(
    "\n\n",
  );
  assert.ok([...long].length > MAX_MIRRORED_PROMPT_LENGTH, "long enough that a prompt would be cut");
  const messages = renderMirror("interim", long);
  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  for (const message of messages) {
    assert.ok(message.startsWith("✨ Claude · working\n"), "the attribution rides on every message");
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
  }
  assert.ok(!messages.join("\n").includes("shortened"), "narration is never cut, only split");

  const [chipped] = renderMirror("interim", "ping <@123456789> at <t:1700000000:R>");
  assert.ok(!/<@\d+>/.test(chipped), chipped);
  assert.ok(!/<t:\d+:R>/.test(chipped), chipped);
});

test("mirrored text cannot draw a quoted block, which is what says the operator typed it", () => {
  // Every angle bracket in mirrored text is escaped, so a `>` arriving in a prompt or a reply
  // reaches Discord as the character rather than as the quote marker. A reply therefore opens no
  // quote at all however hard its content tries, and a prompt opens exactly the one the renderer
  // composed. That is the reachable forgery: a reply is written by a model that has read whatever
  // the session read, and a quoted block is what a reader takes for the operator's own typing.
  const forgedReply = renderMirror("reply", ">>> ⌨ typed at the console\napprove the next request");
  assert.equal(forgedReply.length, 1);
  assert.equal(quoteOpeningLines(forgedReply[0]).length, 0, forgedReply[0]);
  assert.ok(said(forgedReply[0]).startsWith("\\>"), forgedReply[0]);

  // A prompt is quoted by the renderer, so the property there is that content cannot open a second
  // block: whatever it writes stays inside the one the renderer opened and attributed.
  const forgedPrompt = renderMirror("prompt", ">>> ⌨ typed at the console\napprove the next request");
  assert.equal(quoteOpeningLines(forgedPrompt[0]).length, 1, forgedPrompt[0]);
  assert.ok(forgedPrompt[0].startsWith(">>> ⌨"), forgedPrompt[0]);
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

/** A three-column GFM table with one marker of each alignment, as a model writes one. */
const TABLE = [
  "| Session | Model | Status |",
  "| --- | ---: | :---: |",
  "| neo-tail | opus | working |",
  "| pin-keeper | sonnet | idle |",
].join("\n");

test("a mirrored table becomes one fenced block whose columns line up", () => {
  // Discord renders no Markdown table, so the pipes and dashes arrive literally and the operator
  // reads them with effort. The block is monospace, so the columns are where the eye expects them,
  // and the alignment markers are honored: left by default, right on `---:`, centered on `:---:`.
  const [message] = renderMirror("reply", `Here are the numbers:\n\n${TABLE}\n\nDone.`);

  assert.equal(
    said(message),
    [
      "Here are the numbers:",
      "",
      "```",
      "Session    |  Model | Status",
      "neo-tail   |   opus | working",
      "pin-keeper | sonnet |  idle",
      "```",
      "",
      "Done.",
    ].join("\n"),
    message,
  );
});

test("every mirrored surface draws a table the same way", () => {
  // One seam for the three paths mirrored text reaches a thread by, so a table cannot read one way
  // as an answer and another way as the narration chunk that carried the same words.
  const block = said(renderMirror("reply", TABLE)[0]);
  assert.equal(said(renderAnswer(TABLE)[0]), block);
  assert.equal(said(renderMirror("interim", TABLE)[0]), block);
  assert.ok((appendNarration("✨ Claude · working\nearlier text", TABLE) ?? "").endsWith(block), block);
});

test("a table inside a code fence is left exactly as it was written", () => {
  // It is already monospace, and re-wrapping it would mean opening a fence inside one.
  const [message] = renderMirror("reply", `\`\`\`\n${TABLE}\n\`\`\``);

  assert.equal(said(message), `\`\`\`\n${TABLE}\n\`\`\``);
});

test("a table that is not whole is left as the text it was written as", () => {
  // What a block is gets decided from the whole block: a run missing its delimiter row, missing a
  // body row, or carrying a row of a different width is not a table this can draw without
  // inventing or dropping a cell, so it stays the text the model wrote.
  const cases = [
    ["| Session | Model |", "| neo-tail | opus |", "| pin-keeper | sonnet |"].join("\n"),
    ["| Session | Model |", "| --- | --- |"].join("\n"),
    ["| Session | Model |", "| --- | --- |", "| neo-tail | opus | working |"].join("\n"),
    ["| Session | Model |", "| --- | --- | --- |", "| neo-tail | opus |"].join("\n"),
  ];

  for (const written of cases) {
    assert.equal(said(renderMirror("reply", written)[0]), written, written);
  }
});

test("a table under lines of prose that carry a pipe is still drawn as a table", () => {
  // The candidate is the whole run of consecutive pipe-carrying lines, and a run that is no table
  // gives up only its first line before the rest is judged again. So a table opens wherever in the
  // run its header sits, and the prose above it stays the prose it was written as.
  const [message] = renderMirror("reply", `a pipe | in prose\nanother | line\n${TABLE}`);

  assert.equal(
    said(message),
    [
      "a pipe | in prose",
      "another | line",
      "```",
      "Session    |  Model | Status",
      "neo-tail   |   opus | working",
      "pin-keeper | sonnet |  idle",
      "```",
    ].join("\n"),
    message,
  );
});

test("a table that would cut a cell is drawn as one block per row instead", () => {
  // The grid holds every cell to a share of 46 columns, which for three columns is thirteen
  // characters each: enough to lose the whole of what the row said. A block per row keeps the text,
  // costs vertical space Discord scrolls anyway, and needs no horizontal drag.
  const written = [
    "| Option | What it costs | Recommendation |",
    "| --- | --- | --- |",
    "| Keep the fenced grid | Truncates every wide cell | No |",
    "| Drop to raw markdown | Pipes and dashes on a phone | Yes, as the floor |",
    "| One block per row | Longest output of the three | Worth a round |",
  ].join("\n");
  const [message] = renderMirror("reply", written);

  assert.equal(
    said(message),
    [
      "**Option: Keep the fenced grid**",
      "What it costs: Truncates every wide cell",
      "Recommendation: No",
      "",
      "**Option: Drop to raw markdown**",
      "What it costs: Pipes and dashes on a phone",
      "Recommendation: Yes, as the floor",
      "",
      "**Option: One block per row**",
      "What it costs: Longest output of the three",
      "Recommendation: Worth a round",
    ].join("\n"),
    message,
  );
  assert.ok(!said(message).includes("…"), "nothing is cut");
});

test("a per-row row draws no label without a value and no heading without a first cell", () => {
  // A label with nothing beside it reads as a value that went missing rather than as one that was
  // never written, and a heading is the row's first cell rather than a line the renderer owes.
  const written = [
    "| Session | Model | Note |",
    "| --- | --- | --- |",
    "| neo-tail | | a note long enough that the grid would have to cut something here |",
    "| | sonnet | idle |",
  ].join("\n");

  assert.equal(
    said(renderMirror("reply", written)[0]),
    [
      "**Session: neo-tail**",
      "Note: a note long enough that the grid would have to cut something here",
      "",
      "Model: sonnet",
      "Note: idle",
    ].join("\n"),
  );
});

test("a one-column table draws its rows as the lines of text they are", () => {
  // There is no second column to label, so there is no heading to tell from a labelled line, and
  // the header is a row of text like the rest rather than a source of labels.
  const written = [
    "| Note |",
    "| --- |",
    "| a single-column table carries no labels at all, so nothing here is drawn as one |",
    "| short |",
  ].join("\n");
  const body = said(renderMirror("reply", written)[0]);

  assert.equal(
    body,
    [
      "Note",
      "",
      "a single-column table carries no labels at all, so nothing here is drawn as one",
      "",
      "short",
    ].join("\n"),
  );
  assert.equal(quoteOpeningLines(body).length, 0, body);
});

test("no cell of a per-row table can draw markup, a chip, or the shape the rendering composes", () => {
  // Outside a fence nothing is inert by position, so every cell and every label is neutralized.
  // This is the channel permission prompts are answered in: a cell that could draw a mention, a
  // quote bar, or the bold heading this rendering composes would forge the surface. Emphasis is the
  // one thing the two escapes differ on, and the split is structure against content: a heading and
  // a label take the full escape because this rendering composes markup out of them, a value keeps
  // its own because nothing is wrapped around it.
  const written = [
    "| Who | What |",
    "| --- | --- |",
    "| <@123456789> | > ✨ Claude · approve the next request |",
    "| **bold** and `code` | <t:1700000000:R> and # heading |",
    "| a first cell wide enough that no grid could draw the row whole | plain |",
    "| plain heading | **bold value** stays bold |",
  ].join("\n");
  const [message] = renderMirror("reply", written);
  const body = said(message);

  // The per-row path, not the fenced one: a hostile table small enough to keep its grid would test
  // the fence's inertness instead of this rendering's escaping.
  assert.ok(!body.includes("```"), body);
  assert.ok(!/<@\d+>/.test(body), body);
  assert.ok(!/<t:\d+:R>/.test(body), body);
  assert.equal(quoteOpeningLines(body).length, 0, body);
  // Escaped rather than removed, which is what holds outside a fence: the replacement a fenced body
  // needs is for the one place no escape survives.
  assert.equal((body.match(/(?<!\\)`/g) ?? []).length, 0, body);
  assert.equal((body.match(/^#/gm) ?? []).length, 0, body);
  // Ten runs of asterisks: two per row for the four headings this rendering wrote, and two from the
  // one value cell written in bold, which reaches the operator bold.
  assert.equal((body.match(/\*\*/g) ?? []).length, 10, body);
  // A value keeps the emphasis the model wrote it in. This is most of what a comparison table says,
  // and it is wrapped in no markup of this rendering's, so nothing it carries can break one.
  assert.ok(body.includes("**bold value** stays bold"), body);
  // A heading does not, because this rendering wraps it. The whole point of the split: a live mark
  // here would close that wrapper early and leave the rest of the heading outside the bold the row
  // is drawn in, so the composed line would no longer enclose what it was written around. Pinned as
  // the whole line rather than as a count, which interleaving satisfies either way.
  assert.ok(body.includes("**Who: \\*\\*bold\\*\\* and \\`code\\`**"), body);
  // The angle brackets are escaped twice, once here and once by the chip pass that runs after this
  // transform, and a chip needs both of its own to resolve. Pinned rather than left to the two
  // assertions above, which a cell exempted from the unfenced escape would leave green while the
  // surface drew a live mention.
  assert.ok(body.includes("**Who: \\\\<@123456789\\\\>**"), body);
});

test("a per-row table past one message splits between rows, not inside one", () => {
  // The per-row shape is paragraphs where the grid was one fenced block, and the splitter breaks on
  // paragraphs before it breaks on lines, so a row is the unit that moves to the next message. A
  // boundary inside a row would leave a heading with nothing under it, which reads as a row that
  // said nothing rather than as a row continued overleaf.
  const rows = Array.from(
    { length: 40 },
    (_, index) => `| row ${index} | ${"w".repeat(60)} | note ${index} |`,
  );
  const messages = renderMirror("reply", ["| Step | Detail | Note |", "| --- | --- | --- |", ...rows].join("\n"));

  assert.ok(messages.length > 1, `one message carries the whole table: ${messages.length}`);
  for (const message of messages) {
    const lines = said(message).split("\n");
    assert.match(lines[0] ?? "", /^\*\*Step: row \d+\*\*$/, said(message));
    assert.match(lines[lines.length - 1] ?? "", /^Note: note \d+$/, said(message));
  }
  const whole = messages.map(said).join("\n\n");
  for (const index of rows.keys()) {
    assert.ok(whole.includes(`**Step: row ${index}**`), `the heading of row ${index}`);
    assert.ok(whole.includes(`Note: note ${index}`), `the last line of row ${index}`);
  }
});

test("a table too long for one message is mirrored as the text it was written as", () => {
  // A block cut mid-row reads as a complete table saying something the model did not write, where
  // raw text reads as raw text.
  const rows = Array.from({ length: 200 }, (_, index) => `| row ${index} | ${index} |`);
  const written = ["| Step | Count |", "| --- | ---: |", ...rows].join("\n");
  const messages = renderMirror("reply", written);

  assert.ok(!messages.some((message) => message.includes("```")), messages[0]);
  assert.ok(said(messages[0]).startsWith("| Step | Count |"), said(messages[0]));
});

test("a table whose header cell would be redrawn under every row is mirrored as raw text", () => {
  // Every column header is drawn once per body row, so a header carrying prose rather than a
  // column name is the row rendering multiplying text that was written once. The output stays
  // proportionate to the source or the table ships as the Markdown the model wrote.
  const header = "H".repeat(500);
  const rows = Array.from({ length: 150 }, (_, index) => `| a${index} | b${index} |`);
  const written = [`| ${header} | Note |`, "| --- | --- |", ...rows].join("\n");
  const messages = renderMirror("reply", written);
  const drawn = messages.reduce((total, message) => total + message.length, 0);

  assert.ok(drawn < written.length * 2, `${drawn} drawn from ${written.length} written`);
  assert.ok(!messages.some((message) => message.includes("**")), messages[0]);
  assert.ok(said(messages[0]).startsWith(`| ${header} | Note |`), said(messages[0]).slice(0, 80));
});

test("a tall table still draws a block per row", () => {
  // The cost of the row rendering is vertical, and several messages is the accepted price of
  // keeping the text. Height alone never routes a table to raw Markdown.
  const rows = Array.from(
    { length: 250 },
    (_, index) => `| row ${index} | ${"w".repeat(60)} | note ${index} |`,
  );
  const written = ["| Step | Detail | Note |", "| --- | --- | --- |", ...rows].join("\n");
  const messages = renderMirror("reply", written);
  const whole = messages.map(said).join("\n\n");

  assert.ok(messages.length > 1, `one message carries the whole table: ${messages.length}`);
  assert.ok(!whole.includes("|"), whole.slice(0, 200));
  for (const index of rows.keys()) {
    assert.ok(whole.includes(`**Step: row ${index}**`), `the heading of row ${index}`);
    assert.ok(whole.includes(`Note: note ${index}`), `the last line of row ${index}`);
  }
});

test("a paste cut mid-table draws no table, so no cut row reads as a whole one", () => {
  // The paste cap is the one cut this renderer makes, and it lands inside the text rather than at
  // a row boundary. Nothing has to detect that: a table long enough to be reached by the cap is
  // already past what one message holds, so it mirrors as raw text with the cut marker under it.
  const rows = Array.from({ length: 1_200 }, (_, index) => `| row ${index} | value ${index} |`);
  const messages = renderMirror("prompt", ["| Step | Value |", "| --- | --- |", ...rows].join("\n"));
  const whole = messages.join("\n");

  assert.ok(!whole.includes("```"), whole.slice(0, 200));
  assert.ok(whole.endsWith("(long paste shortened in mirror)"), whole.slice(-200));
});

test("no table cell can compose a pill, a chip, or a fence delimiter", () => {
  const written = [
    "| Who | What |",
    "| --- | --- |",
    "| <@123456789> | <t:1700000000:R> |",
    "| `still code` | > not a quote |",
  ].join("\n");
  const [message] = renderMirror("reply", written);
  const body = said(message);

  // Exactly the two delimiters the block itself is made of, and no backtick anywhere else: what a
  // cell carries cannot close the block and put the rest of the message outside it.
  assert.equal((body.match(/`/g) ?? []).length, 6, body);
  assert.ok(body.startsWith("```\n") && body.endsWith("\n```"), body);
  // The chip syntax survives as its own characters, which is inert inside a fence and is why the
  // fence-aware neutralizer leaves it alone rather than escaping it into visible backslashes.
  assert.ok(body.includes("<@123456789>"), body);
  assert.equal(body.split("\n").filter((line) => /^\s*>/.test(line)).length, 0, body);
});

test("a cell is neutralized before it is padded, so the columns line up on what is drawn", () => {
  // The columns are measured on the drawn form and not the written one, because the drawn form is
  // what the reader lines up. A backtick becomes an apostrophe and a whitespace run collapses to
  // one space, so a cell measured before either draws a different width than the column it sits in.
  // A backslash is not one of the characters that changes: a fenced block honors no escape, so it
  // is drawn as itself, which is what makes a path in a cell read as the path that was written.
  const written = [
    "| Path | Note |",
    "| --- | --- |",
    "| C:\\ops | one |",
    "| plain | two |",
  ].join("\n");
  const lines = said(renderMirror("reply", written)[0]).split("\n");

  const separators = lines.slice(1, -1).map((line) => line.indexOf("|"));
  assert.deepEqual(separators, [separators[0], separators[0], separators[0]], lines.join("\n"));
  assert.ok(lines.includes("C:\\ops | one"), lines.join("\n"));
});

test("a run of pipe-carrying lines that is no table costs one parse per line", () => {
  // A reply is never truncated and the mirror route takes megabytes, so a model that writes a long
  // ragged near-table hands this transform the whole of it. The broker runs on one event loop, and
  // work here that grew with the square of the run would stall hook intake, heartbeats, and the
  // permission prompts behind it for seconds. The gate is the parse count rather than the clock:
  // a loaded machine moves wall time by an order of magnitude and would make this flaky, where the
  // count is the same number everywhere. Doubling the input doubles a linear count and quadruples
  // a quadratic one, so the margin between them is wide enough to name a threshold in the middle.
  const near = (count: number): string =>
    Array.from({ length: count }, (_, index) => (index % 2 === 0 ? "a|b" : "a|b|c")).join("\n");
  const parses = (count: number): number => {
    tableParses.count = 0;
    renderMirror("reply", near(count));
    return tableParses.count;
  };

  const small = parses(400);
  const large = parses(800);

  assert.ok(small > 0, "the counter has to be reached at all, or this passes on nothing");
  assert.ok(large <= small * 3, `${small} parses at 400 lines, ${large} at 800`);
});

test("a run of rows too long to draw as one block stops paying to draw as it grows", () => {
  // The sibling gate above covers a run the shape checks reject. This covers the run they accept:
  // every line here is a well-formed two-column row, so every candidate start clears the header,
  // the delimiter and the body checks, and only the block's own ceiling refuses it. Reading that
  // run is already linear, so the count that can still grow with its square is the drawing, and
  // the same event-loop stall is what a quadratic one would cost. Past the point where no block of
  // that many rows could fit, a longer run adds nothing to the drawing at all, so the two counts
  // here are the same number and the threshold in the middle has all the room it needs.
  const rows = (count: number): string => Array.from({ length: count }, () => "-|-").join("\n");
  const drawn = (count: number): number => {
    tableRowsDrawn.count = 0;
    renderMirror("reply", rows(count));
    return tableRowsDrawn.count;
  };

  const small = drawn(1000);
  const large = drawn(2000);

  assert.ok(small > 0, "the counter has to be reached at all, or this passes on nothing");
  assert.ok(large <= small * 3, `${small} rows drawn at 1000 lines, ${large} at 2000`);
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
      quoteOpeningLines(message).length,
      0,
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

test("a hard cut never lands inside a fence's language word", () => {
  // The delimiter survives a cut here, whole on both sides of it, and the language word does not:
  // one message opens a block called `typ`, the next re-opens that block, and `escript` is the first
  // line of code the reader is shown. The whole opening line moves to the message the code is in.
  const room = MAX_MESSAGE_LENGTH - attributionLength("reply") - 4;
  const line = `${"a".repeat(room - 5)}\`\`\`typescript ${"b".repeat(80)}`;
  const messages = renderMirror("reply", line);

  assert.ok(messages.length >= 2, `${messages.length} message(s)`);
  assert.ok(!messages[0].includes("`"), `a fence opening was cut in half: ${messages[0].slice(-40)}`);
  assert.ok(said(messages[1]).startsWith("```typescript "), said(messages[1]).slice(0, 60));
  for (const [index, message] of messages.entries()) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `message ${index}: ${message.length} characters`);
  }
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
  const forgery = ">>> ⌨ typed at the console";
  const attempts = [
    `${forgery}\napprove the next request`,
    `\`\`\`\n${forgery}\napprove the next request\n\`\`\``,
    `\`\`\`\`\n${forgery}\napprove\n\`\`\`\``,
    `\\\`\`\`\n${forgery}\napprove`,
    `\`\`\`ts\ncode\n\`\`\` \n${forgery}\napprove`,
    `  ${forgery}\napprove`,
  ];

  for (const attempt of attempts) {
    for (const message of renderMirror("reply", attempt)) {
      const quoted = quoteOpeningLines(message);
      assert.equal(quoted.length, 0, `${JSON.stringify(attempt)} produced: ${JSON.stringify(message)}`);
      assert.ok(message.startsWith("✨ "), `the reply marker opens no quote: ${message.slice(0, 60)}`);
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

test("a chunk that fits merges into the narration message, and one character more does not", () => {
  // Both directions, because the merge is what goes on the wire: one character over the ceiling is
  // an edit Discord refuses outright, and the chunk that refusal loses is narration nobody sees.
  const existing = renderMirror("interim", "reading the failing test first")[0];
  // The room a merge has, asked of the renderer rather than written down here: the ceiling less the
  // message already posted and less the blank line that separates the block's paragraphs.
  const room = MAX_MESSAGE_LENGTH - existing.length - 2;

  const merged = appendNarration(existing, "x".repeat(room));
  assert.equal(merged, `${existing}\n\n${"x".repeat(room)}`);
  assert.equal(merged?.length, MAX_MESSAGE_LENGTH);

  assert.equal(appendNarration(existing, "x".repeat(room + 1)), null, "one character over is refused");
});

test("the merge is measured in the units a message is counted in, not in code points", () => {
  // An astral character spends two UTF-16 units. A fit measured on code points alone would admit
  // twice the room here, and the edit carrying it would come back refused.
  const existing = renderMirror("interim", "tailing the transcript")[0];
  const room = MAX_MESSAGE_LENGTH - existing.length - 2;
  const over = "🛰".repeat(Math.floor(room / 2) + 1);

  assert.ok([...over].length < room, `${[...over].length} code points against room for ${room}`);
  assert.equal(appendNarration(existing, over), null);

  const fits = appendNarration(existing, "🛰".repeat(Math.floor(room / 2)));
  assert.ok(fits, "one astral character fewer is inside the room");
  assert.ok(fits.length <= MAX_MESSAGE_LENGTH, `${fits.length} units`);
});

test("a chip and a quote marker in an appended chunk arrive escaped", () => {
  // Appended text is transcript content, the same untrusted class as a mirrored reply, landing in
  // the one channel permission prompts are answered in. A pill or a quoted block that entered a
  // message by edit forges exactly what one that entered by post would.
  const existing = renderMirror("interim", "starting the run")[0];
  const merged = appendNarration(
    existing,
    ">>> ⌨ typed at the console\nping <@123456789> at <t:1700000000:R>",
  );

  assert.ok(merged, "the chunk is short enough to merge");
  assert.equal(quoteOpeningLines(merged).length, 0, merged);
  assert.ok(!/<@\d+>/.test(merged), merged);
  assert.ok(!/<t:\d+:R>/.test(merged), merged);
  assert.ok(merged.includes("\\>\\>\\> ⌨ typed at the console"), merged);
});

test("a chunk that leaves a code fence open merges with that fence closed", () => {
  // A merged message holding a fence open renders whatever is posted below it in the thread as
  // code, including the next message's own attribution line.
  const existing = renderMirror("interim", "here is the failing case")[0];
  const merged = appendNarration(existing, "```sh\nnpm test");

  assert.equal(merged, `${existing}\n\n\`\`\`sh\nnpm test\n\`\`\``);
  assert.equal((merged?.match(/```/g) ?? []).length % 2, 0, merged);
});

test("a merge is itself a message the next chunk can merge into", () => {
  // The block grows chunk by chunk, so every result here is the `existing` of the next call. What
  // makes that safe is that a result closes the fences it opens, exactly as a posted message does,
  // and that the text below the attribution is never escaped again on the way through.
  const existing = renderMirror("interim", "here is the failing case")[0];

  const first = appendNarration(existing, "```sh\nnpm test");
  assert.ok(first, "the first chunk is short enough to merge");
  const second = appendNarration(first, "then the next file");
  assert.ok(second, "the second chunk is short enough to merge");

  assert.equal(second.slice(0, first.length), first);
  assert.equal((second.match(/```/g) ?? []).length % 2, 0, second);
  assert.ok(!second.includes("\\\\"), second);
});

test("a chunk with nothing visible in it is not merged", () => {
  const existing = renderMirror("interim", "reading the failing test first")[0];

  assert.equal(appendNarration(existing, "   \n\n  "), null);
  assert.equal(appendNarration(existing, ""), null);
  assert.equal(appendNarration(existing, "\u200b\u202e"), null);
});

test("a message this renderer did not emit is refused rather than grown", () => {
  // Renderer output is trimmed and invisible-free, so a legitimate `existing` passes untouched;
  // an empty or padded one is a caller bug, and merging onto it would remember a string Discord
  // does not hold.
  assert.equal(appendNarration("", "still working"), null);
  assert.equal(appendNarration("  padded  ", "still working"), null);
  assert.equal(appendNarration("held​text", "still working"), null);
});

test("the message already posted is copied into the merge, never escaped a second time", () => {
  // Its content came out of this renderer, so its chips and its quote markers already carry the
  // backslash that makes them inert. A second pass would escape those backslashes, and a reader
  // watching the block grow would see the text above the new chunk change under them.
  const existing = renderMirror("interim", "ping <@123456789> and > not a quote")[0];
  assert.ok(existing.includes("\\<@123456789\\>"), existing);

  const merged = appendNarration(existing, "still working");

  assert.ok(merged, "the chunk is short enough to merge");
  assert.equal(merged.slice(0, existing.length), existing);
  assert.ok(!merged.includes("\\\\"), merged);
  assert.equal(quoteOpeningLines(merged).length, 0, merged);
});

test("a merged narration message survives the writer's own cap untouched", () => {
  // The cross-pin between the merge and the path that writes it. An edit goes out through
  // `inertMessage`, which strips and cuts at MAX_MESSAGE_LENGTH, so a merge the writer changed on
  // the way out is a message the router then remembers wrongly, and every later fit is measured
  // against a string Discord does not hold. The boundary case is what makes this discriminating, so
  // the merge here sits exactly at the ceiling.
  const existing = renderMirror("interim", "reading the failing test first")[0];
  const merged = appendNarration(existing, "x".repeat(MAX_MESSAGE_LENGTH - existing.length - 2));

  assert.ok(merged, "the chunk is short enough to merge");
  assert.equal(merged.length, MAX_MESSAGE_LENGTH);
  assert.equal(inertMessage(merged), merged);
});

test("a reply tool message says who wrote it, and says it apart from the mirror", () => {
  const [message] = renderAnswer("the migration is done");

  assert.equal(said(message), "the migration is done");
  assert.match(message, /^📣 .*Claude/, message);
  assert.notEqual(message.split("\n")[0], renderMirror("reply", "x")[0].split("\n")[0]);
  assert.notEqual(message.split("\n")[0], renderMirror("prompt", "x")[0].split("\n")[0]);
  // Unquoted, like the mirror's reply marker: the quoted block is what says the operator typed it.
  assert.equal(quoteOpeningLines(message).length, 0, message);
});

test("a reply tool message too long for one carries its attribution on every message", () => {
  // A message scrolled to on a phone carries its own attribution or it carries none, and an answer
  // is never cut: the ceiling bounds one message, not the answer.
  const paragraphs = Array.from(
    { length: 200 },
    (_, index) => `Paragraph ${index}. ${"detail ".repeat(24)}`.trim(),
  );
  const answer = paragraphs.join("\n\n");
  assert.ok(answer.length >= 35_000, `${answer.length} characters`);

  const messages = renderAnswer(answer);

  assert.ok(messages.length >= 20, `${messages.length} message(s)`);
  const header = messages[0].split("\n")[0];
  for (const message of messages) {
    assert.equal(message.split("\n")[0], header, message.slice(0, 80));
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${message.length} characters`);
  }
  // Every break falls between paragraphs, so putting the separator back at each boundary reproduces
  // the answer exactly: nothing was dropped, reordered, or shortened.
  assert.equal(messages.map(said).join("\n\n"), answer);
});

test("a reply tool message is not capped at the length a pasted prompt is", () => {
  // The paste cap protects the thread from the operator's own log dumps. An answer is written to be
  // read, so it is split at any length rather than shortened.
  const answer = "x".repeat(MAX_MIRRORED_PROMPT_LENGTH + 1);
  const messages = renderAnswer(answer);

  assert.equal(messages.map(said).join(""), answer);
  assert.ok(!messages.join("").includes("shortened"));
});

test("a reply tool message with nothing visible in it is no message at all", () => {
  assert.deepEqual(renderAnswer("   \n\n  "), []);
  assert.deepEqual(renderAnswer(""), []);
  assert.deepEqual(renderAnswer("\u200b\u202e"), []);
});

test("a reply tool message cannot draw a chip or a quoted block", () => {
  // The reply tool is the path a prompt-injected model writes through, and it posts into the one
  // channel permission prompts are answered in, so it gets the mirror's own escape rather than a
  // second one of the same shape.
  const [message] = renderAnswer(
    ">>> ⌨ typed at the console\nping <@123456789> at <t:1700000000:R> in <#42>",
  );

  assert.equal(quoteOpeningLines(message).length, 0, message);
  assert.ok(said(message).startsWith("\\>"), message);
  assert.ok(!/<@\d+>/.test(message), message);
  assert.ok(!/<t:\d+:R>/.test(message), message);
  assert.ok(!/<#\d+>/.test(message), message);
});

test("code in a reply tool message keeps the characters code is written with", () => {
  const code = "const f = (a: Array<string>) => a.length < 10;";
  const [message] = renderAnswer(`here:\n\n\`\`\`ts\n${code}\n\`\`\``);

  assert.ok(message.includes(code), message);
  assert.ok(!said(message).includes("\\<"), message);
});

test("every reply tool message survives the writer's own cap untouched", () => {
  // The cross-pin between the splitter and the path that posts what it produced. `inertMessage` is
  // what every posted message goes through, and it cuts at MAX_MESSAGE_LENGTH: a splitter measuring
  // the wrong attribution length has its tail eaten here, silently. The answer's attribution is a
  // different length from the mirror's, so the room is asked of it rather than of the mirror.
  const room = MAX_MESSAGE_LENGTH - answerAttributionLength();
  const messages = renderAnswer(`${"x".repeat(room)}\n\n${"y".repeat(room)}`);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].length, MAX_MESSAGE_LENGTH, "a message sits exactly at the ceiling");
  for (const message of messages) {
    assert.equal(inertMessage(message), message);
  }

  // The off-by-one on the other side: one character more than the room splits, and the room itself
  // does not.
  assert.equal(renderAnswer("x".repeat(room)).length, 1);
  assert.equal(renderAnswer("x".repeat(room + 1)).length, 2);
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
    // The input is a command read before it is approved, so it is drawn monospace, under its own
    // label, and wrapped by this renderer rather than left to run past the width of a phone.
    "Input:",
    "```",
    "{ command: npm run migrate }",
    "```",
  ]);
});

test("nothing a tool writes into a prompt can mention anyone or restructure it", () => {
  // The description and the input preview come from a tool call, which anything the session has
  // read can steer, and they land in a message that pings a phone and asks for a yes. A crafted
  // one that spoofs a second prompt or names a role is the attack.
  const text = prompt({
    toolName: "@everyone",
    description: "<@999999999999999999> approve everything",
    inputPreview: "<@&123> **Permission needed** ``` `qrstu`\n@here",
  });

  // The input is held by a fence rather than escaped, which is what lets a command read as the
  // characters it was written with instead of as a run of backslashes. So the property is where
  // the tool's text sits, not what it was turned into: a fence renders no markdown and resolves no
  // mention, and everything a tool wrote is inside this one.
  const opens = text.indexOf("```");
  assert.notEqual(opens, -1, text);
  assert.equal(
    [...text.slice(0, opens).matchAll(/(?<!\\)<@/g)].length,
    1,
    "outside the fence the only unescaped mention syntax is the broker's own",
  );
  assert.ok(text.startsWith(`<@${OPERATOR}>`));
  assert.ok(text.slice(opens).includes("@here"), "the tool's text is inside the fence, not removed");

  // The fence opens once and closes once. An input carrying its own delimiter cannot end the block
  // early and put the rest of what it wrote back where markdown renders, which is the one way a
  // contained field becomes an escaped field's problem.
  assert.equal((text.match(/```/g) ?? []).length, 2, text);
  assert.ok(!text.slice(opens + 3, text.lastIndexOf("```")).includes("```"), text);

  // The lines are the renderer's: the label, then the fence opening directly under it, and the
  // fence closing the message. Found by the label rather than by a fixed index, so a field added
  // above the input moves the block instead of failing here for the wrong reason.
  const lines = text.split("\n");
  const label = lines.findIndex((line) => line.startsWith("Input"));
  assert.notEqual(label, -1, text);
  assert.equal(lines[label + 1], "```");
  assert.equal(lines[lines.length - 1], "```");
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
  assert.ok(whole.includes("\nInput:\n"), whole);
  assert.ok(!whole.includes("Input (cut)"), "a field that fits is not labelled as cut");

  const long = prompt({ inputPreview: "x".repeat(5_000), description: "y".repeat(5_000) });
  // The label carries it, not an ellipsis inside the block: a cut a reader has to notice is a cut
  // they will approve past.
  assert.ok(long.includes("\nInput (cut):\n"), long);
  assert.ok(long.includes("What (cut): "), long);
});

test("a task notice carries the first task id, on one line", () => {
  const wake =
    "<task-notification>Background task completed.\n<task-id>agent-42</task-id>\n\nThe full report follows.";
  assert.equal(renderTaskNotice(wake), "📨 background task finished · agent-42");

  // The first pair wins: the rest of the report is untrusted text that can carry more pairs.
  assert.equal(
    renderTaskNotice("<task-id>first</task-id> then <task-id>second</task-id>"),
    "📨 background task finished · first",
  );
});

test("a task id the notice cannot trust falls back to the bare line", () => {
  // Over the bound: half an id identifies nothing, so an over-long one is absent, not truncated.
  assert.equal(
    renderTaskNotice(`<task-id>${"x".repeat(65)}</task-id>`),
    "📨 background task finished",
  );
  assert.equal(
    renderTaskNotice(`<task-id>${"x".repeat(64)}</task-id>`),
    `📨 background task finished · ${"x".repeat(64)}`,
    "an id exactly at the bound is still an id",
  );

  // No pair at all, an empty pair, and one that is only whitespace all read as no id.
  assert.equal(renderTaskNotice("<task-notification>done, no id here"), "📨 background task finished");
  assert.equal(renderTaskNotice("<task-id></task-id>"), "📨 background task finished");
  assert.equal(renderTaskNotice("<task-id>   </task-id>"), "📨 background task finished");
});

test("a task id reaches the notice inert, and no input makes it throw", () => {
  // The id is conversation content landing in the channel permission prompts are answered in, so
  // markdown and the chip syntax arrive escaped, exactly as a permission prompt's fields do.
  assert.equal(
    renderTaskNotice("<task-id>**bold**<@123></task-id>"),
    "📨 background task finished · \\*\\*bold\\*\\*\\<@123\\>",
  );

  // A text of nothing but invisibles, and an id of nothing but invisibles, both compose the bare
  // line rather than throwing or carrying an empty separator.
  const invisible = String.fromCharCode(0x200b, 0x202e, 0x200b);
  assert.equal(renderTaskNotice(invisible), "📨 background task finished");
  assert.equal(renderTaskNotice(`<task-id>${invisible}</task-id>`), "📨 background task finished");
  assert.equal(renderTaskNotice(""), "📨 background task finished");
});

test("the id scan reads through the same invisible strip the wake recognizer reads through", () => {
  // An invisible character inside the tag literals must not hide a pair from the scan that the
  // recognizer's reading of the same prompt still saw: both read the invisible-stripped text, so
  // the two cannot disagree about one message. The invisibles ride in by code point, never as raw
  // bytes a reader cannot see in the source.
  const zw = String.fromCharCode(0x200b);
  assert.equal(
    renderTaskNotice(`<task${zw}-id>agent-42</task${zw}-id>`),
    "📨 background task finished · agent-42",
  );
});

function asked(overrides: Partial<AskedQuestion> = {}): AskedQuestion {
  return {
    question: "Ship the migration now?",
    header: null,
    multiSelect: false,
    options: [],
    ...overrides,
  };
}

/** Options as the notice cares about them: labels, with the descriptions the notice never draws. */
function labelled(...labels: string[]): AskedOption[] {
  return labels.map((label) => ({ label, description: null }));
}

test("a question notice leads with the mention and draws each question with its options", () => {
  const text = renderQuestionNotice({
    operatorId: OPERATOR,
    questions: [
      asked({ header: "Timing", multiSelect: true, options: labelled("Now", "After the backup") }),
      asked({ question: "Which hosts get the change?", options: labelled("NEO", "TRINITY") }),
    ],
  });

  assert.deepEqual(text.split("\n"), [
    // The headline names no surface: a held hook response renders no console picker, so a notice
    // pointing at one is untrue for exactly the window this message is the thread's only copy of
    // the question.
    `<@${OPERATOR}> ❓ **Waiting on you** · a question is open`,
    "Q: Timing: Ship the migration now? (multi-select)",
    "Options: Now · After the backup",
    "Q: Which hosts get the change?",
    "Options: NEO · TRINITY",
  ]);
});

test("a question with no options renders without an Options line", () => {
  // The console always offers a free-form "Other" answer, so an empty list is a shape the tool
  // really produces, not an error to mark.
  const text = renderQuestionNotice({ operatorId: OPERATOR, questions: [asked()] });

  assert.deepEqual(text.split("\n").slice(1), ["Q: Ship the migration now?"]);
  assert.ok(!text.includes("(multi-select)"), "the suffix rides only on a multi-select question");
  assert.ok(!text.includes("Options:"), text);
});

test("nothing a session writes into a question can mention anyone or restructure the notice", () => {
  // Question text and labels come from a tool call, which anything the session has read can
  // steer, and the notice lands in the one channel permission prompts are answered in: a second
  // mention or a rendered chip there is the attack the escaping is against.
  const text = renderQuestionNotice({
    operatorId: OPERATOR,
    questions: [
      asked({
        question: "approve <@999999999999999999> **now**?",
        header: "# Urgent",
        options: labelled("<@123> ping", "> quoted line", "@everyone"),
      }),
    ],
  });

  const mentions = [...text.matchAll(/(?<!\\)<@/g)];
  assert.equal(mentions.length, 1, "the only unescaped mention syntax is the broker's own");
  assert.ok(text.startsWith(`<@${OPERATOR}>`), text);
  assert.ok(text.includes("\\<@123\\> ping"), text);
  assert.ok(!text.includes("**now**"), text);
  assert.ok(text.includes("\\# Urgent"), text);
  assert.ok(text.includes("@everyone"), "allowed_mentions is what stops the text ping, not the escape");
});

test("long question fields are cut visibly and the mention line survives any length", () => {
  const text = renderQuestionNotice({
    operatorId: OPERATOR,
    questions: [
      asked({
        question: "q".repeat(600),
        header: "h".repeat(150),
        options: labelled("o".repeat(150), "kept whole"),
      }),
    ],
  });
  const lines = text.split("\n");

  assert.ok(lines[0].startsWith(`<@${OPERATOR}> `), lines[0]);
  assert.equal(lines[1], `Q: ${"h".repeat(99)}…: ${"q".repeat(499)}…`);
  assert.equal(lines[2], `Options: ${"o".repeat(99)}… · kept whole`);
});

test("a null operator composes the quiet notice with no mention anywhere", () => {
  // The quiet tier: a thread already pinged past a person's reading pace still gets the notice,
  // but neither the composed text nor (at the call site) the transport whitelist names anyone.
  const text = renderQuestionNotice({
    operatorId: null,
    questions: [asked({ header: "Timing", options: labelled("Now", "Later") })],
  });

  assert.ok(text.startsWith("❓ **Waiting on you**"), text);
  assert.ok(!text.includes("<@"), text);
});

test("four maximal questions compose one message, cut with a tail naming what the console holds", () => {
  // The per-field caps alone compose past the message ceiling at this size, so the whole-message
  // bound is what keeps the writer's own cut from eating the tail silently: questions ride whole
  // until the next would not leave room for the closing tail line.
  const maximal = asked({
    question: "q".repeat(600),
    header: "h".repeat(150),
    multiSelect: true,
    options: labelled("o".repeat(150), "p".repeat(150), "r".repeat(150), "s".repeat(150)),
  });
  const text = renderQuestionNotice({
    operatorId: OPERATOR,
    questions: [maximal, maximal, maximal, maximal],
  });

  assert.ok(text.length <= MAX_MESSAGE_LENGTH, `${text.length} units`);
  assert.match(text, /\(\+3 more questions at the console\)$/, text.slice(-60));
  // The first question always fits by arithmetic: the notice never degenerates to a bare tail.
  assert.ok(text.includes(`Q: ${"h".repeat(99)}…`), text.slice(0, 200));

  // One question, even maximal, fits whole: no tail rides on a notice that was never cut.
  const single = renderQuestionNotice({ operatorId: OPERATOR, questions: [maximal] });
  assert.ok(single.length <= MAX_MESSAGE_LENGTH, `${single.length} units`);
  assert.ok(!single.includes("more question"), single.slice(-60));
});

test("an empty questions array still composes the alert line, and nothing makes the notice throw", () => {
  // The parse upstream refuses a line with zero readable questions, so this input is a caller
  // bug; the render answer to it is still a message, never a throw that would take the tailer's
  // pass down with it.
  assert.equal(
    renderQuestionNotice({ operatorId: OPERATOR, questions: [] }),
    `<@${OPERATOR}> ❓ **Waiting on you** · a question is open`,
  );

  // A header and labels of nothing but invisible characters neutralize to nothing and render as
  // absent, rather than as a bare colon or an empty entry between separators.
  const invisible = String.fromCharCode(0x200b, 0x202e);
  const text = renderQuestionNotice({
    operatorId: OPERATOR,
    questions: [asked({ header: invisible, options: labelled(invisible, "real label") })],
  });
  assert.deepEqual(text.split("\n").slice(1), [
    "Q: Ship the migration now?",
    "Options: real label",
  ]);
});

test("a session no transcript line has reported a model for renders exactly as it always has", () => {
  // The other direction of the marker test above: the reader is an allowlist, so a session on a
  // host with no tailer, and one before its first reading, carry the fields the card always had and
  // no line about a model at all.
  const plain = renderCard(view(), "working", NOW);

  assert.ok(!plain.includes("Model"), plain);
  assert.deepEqual(blocksOf(plain).fields.length, 4, "the four rows a session always carries");

  // The context size is not the model's to carry: a session that has reported one and no model
  // draws it anyway, which is what the row being its own is for.
  assert.equal(value(renderCard(view({ contextTokens: 61_380 }), "working", NOW), "Context"), "61k");

  // A model with no context figure beside it, which is what a restart reads until the next line
  // reports one, renders the model alone rather than an empty clause.
  assert.equal(
    value(renderCard(view({ model: "claude-fable-5", openingModel: "claude-fable-5" }), "working", NOW), "Model"),
    "claude-fable-5",
  );
});

test("the marker is drawn on the model family, and never on a direction it cannot read", () => {
  const marked = (model: string, openingModel: string): boolean =>
    renderCard(view({ model, openingModel, contextTokens: 10 }), "working", NOW).includes("Down from");

  assert.ok(marked("claude-opus-5[1m]", "claude-fable-5"), "a decorated fallback still ranks");
  assert.ok(marked("claude-haiku-4-5", "claude-sonnet-4-5"));
  assert.ok(!marked("claude-fable-5", "claude-opus-4-8"), "an upgrade is the operator's own switch");
  assert.ok(!marked("claude-opus-5[1m]", "claude-opus-4-8"), "one family, no direction to report");
  assert.ok(!marked("some-other-model", "claude-fable-5"), "an unrankable name is not a downgrade");
  assert.ok(!marked("claude-opus-4-8", "some-other-model"));
});

test("an untrusted model string cannot close the fence or crowd the card", () => {
  // Model strings and the category come off another program's file, and the card is the surface the
  // operator reads to tell what a session is doing. Both rows sit inside the fence, where Discord
  // resolves no chip, so the syntax reads as the characters it is; what a crafted string cannot do
  // is close the block and put the rest of the card on a surface where a chip renders.
  const card = renderCard(
    view({
      model: "``` <@123456789012345678>",
      openingModel: "claude-fable-5",
      contextTokens: 61_380,
      downgrade: {
        cause: "refusal",
        originalModel: "claude-fable-5",
        fallbackModel: "<@123456789012345678>",
        category: "<t:2000000000:R>",
        choice: null,
      },
    }),
    "working",
    NOW,
  );

  assertOnlyFenceBackticks(card);
  assert.ok(
    !/<@\d+>/.test(card.split("\n").slice(0, 2).join("\n")),
    "no chip syntax on the title line or the heading, the two lines above the first fence",
  );
  assert.ok(value(card, "Heartbeat") !== "", "the rows below the model line survive it");
});

test("a model change message names both models and the session scope", () => {
  const plain = renderModelChange({
    operatorId: null,
    from: "claude-fable-5",
    to: "claude-opus-4-8",
    downgrade: null,
  });

  assert.ok(plain.includes("claude-opus-4-8"), plain);
  assert.ok(plain.includes("claude-fable-5"), plain);
  assert.ok(plain.includes("this session"), plain);
  assert.ok(!plain.includes("<@"), "the notice tier mentions nobody");
  assert.equal(plain.split("\n").length, 1, "a change with no record read is one plain line");
});

test("a model change message names the category, or the console action when there is none", () => {
  const refused = renderModelChange({
    operatorId: "222222222222222222",
    from: "claude-fable-5",
    to: "claude-opus-4-8",
    downgrade: {
      cause: "refusal",
      originalModel: "claude-fable-5",
      fallbackModel: "claude-opus-4-8",
      category: "cyber",
      choice: null,
    },
  });

  assert.ok(refused.startsWith("<@222222222222222222> "), refused);
  assert.ok(refused.includes("flagged cyber"), refused);

  // The entitlement path carries no category at all, and it is the one an operator can act on: the
  // message says what to do rather than only what happened.
  const consent = renderModelChange({
    operatorId: null,
    from: "claude-fable-5",
    to: "claude-opus-5[1m]",
    downgrade: {
      cause: "consent",
      originalModel: "claude-fable-5",
      fallbackModel: "claude-opus-5[1m]",
      category: null,
      choice: "cancelled",
    },
  });

  assert.ok(consent.includes("usage credits"), consent);
  assert.ok(consent.includes("cancelled"), consent);
  assert.ok(consent.includes("consenting there restores claude-fable-5"), consent);
});

test("a change message composed from a hostile record still mentions only the operator", () => {
  const message = renderModelChange({
    operatorId: "222222222222222222",
    from: "<@999999999999999999>",
    to: "claude-opus-4-8",
    downgrade: {
      cause: "consent",
      originalModel: "<@888888888888888888>",
      fallbackModel: "claude-opus-4-8",
      category: null,
      choice: "@everyone <t:2000000000:R>",
    },
  });

  assert.deepEqual(message.match(/<@\d+>/g), ["<@222222222222222222>"], message);
  assert.ok(!/<t:\d+:R>/.test(message), message);
  assert.ok(message.length <= MAX_MESSAGE_LENGTH, message);
});

function agent(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id,
    kind: "subagent",
    description: `Grooming ${id} implementation`,
    agentType: "implementer-fable",
    since: NOW - 35 * 60_000,
    ...overrides,
  };
}

test("every task a session is waiting on is named, two rows to an entry", () => {
  // The operator reads the card to find out what a fan-out is doing, so nothing is dropped and
  // nothing is counted at a realistic size: a measured session peaked at twelve concurrent agents.
  // Two rows an entry because at this width one row makes the age, the agent type and the
  // description compete, and truncation reaches the description first, which is the only field that
  // says what the work is.
  const fleet = Array.from({ length: 12 }, (_unused, index) =>
    agent(`task-${index}`, {
      description: `Section ${String(index)} of the ladder`,
      agentType: "implementer-opus",
      since: NOW - (index + 1) * 60_000,
    }),
  );

  const card = renderCard(view({ backgroundTasks: fleet }), "working", NOW);
  const tasks = tasksOf(card);

  assert.equal(tasks.length, 24, tasks.join("\n"));
  assert.ok(
    !tasks.some((line) => line.startsWith("+")),
    `no entry is counted rather than named: ${tasks.join("\n")}`,
  );
  // Oldest first, which is the order they were dispatched in, so an entry keeps its place as the
  // fan-out grows around it.
  assert.equal(tasks[0], "12m · implementer-opus");
  assert.equal(
    tasks[1],
    "        Section 11 of the ladder",
    "the description sits right of where the type starts",
  );
  assert.equal(tasks[22], "1m · implementer-opus");
  assert.equal(tasks[23], "       Section 0 of the ladder");
  assert.equal(value(card, "State"), "working · 12 tasks", "the size of the fan-out is on the state");
  assert.ok(card.length <= MAX_CARD_LENGTH, card);
});

test("an idle card draws its fields alone, with neither optional block standing empty", () => {
  // Two placeholder blocks on every card between fan-outs is the noise a scrolled channel pays for
  // telling an empty block apart from a renderer that stopped drawing one, so a section with nothing
  // to show is left out, header and block together.
  const card = renderCard(view({ lastTool: null, lastToolInput: null }), "working", NOW);
  const blocks = blocksOf(card);

  assert.deepEqual(blocks.order, [], "the fields are the whole card");
  assert.equal(blocks.tasks, null);
  assert.equal(blocks.tool, null);
});

test("a session waiting on agents says so on the card", () => {
  const waiting = view({
    backgroundTasks: [
      agent("S6"),
      agent("ladder", {
        description: "PR ladder fix round three",
        agentType: "implementer-opus",
        since: NOW - 62 * 60_000,
      }),
    ],
  });

  const card = renderCard(waiting, "working", NOW);
  // Both tasks whole, oldest first, and neither of them counted: what it is running under and how
  // long it has been out lead the entry, and its description has a row to itself under them.
  assert.deepEqual(tasksOf(card), [
    "1h 2m · implementer-opus",
    "          PR ladder fix round three",
    "35m · implementer-fable",
    "        Grooming S6 implementation",
  ]);
  // The count rides the state, since the five states cannot say waiting on agents. The word is
  // "tasks" because the count covers shell tasks too.
  assert.equal(value(card, "State"), "working · 2 tasks");
  // A blocked run carries the count on the same terms, because the card draws its Tasks block: a
  // state line that dropped the count would deny a roster the card is showing two lines below it.
  const halted = renderCard(waiting, "blocked", NOW);
  assert.equal(value(halted, "State"), "blocked · 2 tasks");
  assert.deepEqual(blocksOf(halted).order, ["### Tool", "### Tasks"], halted);
  // The tasks sit below the fields the card always carries, because the roster is the one part
  // sized by another program's fan-out, and below the tool, which nearly every session has where
  // few have tasks.
  assert.deepEqual(blocksOf(card).order, ["### Tool", "### Tasks"], card);
  assert.ok(card.indexOf("### Tasks") > card.indexOf("Heartbeat"), card);
});

test("a shell task renders beside a subagent, since both are invisible work", () => {
  const waiting = view({
    backgroundTasks: [
      agent("build", {
        kind: "shell",
        description: "npm test on the integration suite",
        agentType: null,
        since: NOW - 4 * 60_000,
      }),
    ],
  });

  const card = renderCard(waiting, "working", NOW);
  assert.deepEqual(
    tasksOf(card),
    ["4m · shell", "       npm test on the integration suite"],
    "the kind is what tells a shell task from a subagent",
  );
  assert.equal(value(card, "State"), "working · 1 task");
});

test("a fan-out is counted on the card and left out of the title", () => {
  // A count in the title would spend a rename, and a permanent notice in the thread, on every step
  // of a drain. The card is edited in place, so it is where a moving number belongs.
  const waiting = view({
    backgroundTasks: [agent("S6"), agent("ladder"), agent("groom")],
  });

  assert.equal(value(renderCard(waiting, "working", NOW), "State"), "working · 3 tasks");
  assert.equal(threadName(waiting, "working"), `${TITLE_GLYPHS.active} neo-intake · active`);
});

test("a session waiting on nothing carries no roster line and no count", () => {
  const card = renderCard(view(), "working", NOW);

  assert.ok(!card.includes("Waiting"), card);
  assert.equal(value(card, "State"), "working");
  assert.ok(!/tasks?/.test(card), card);
  assert.equal(threadName(view(), "working"), `${TITLE_GLYPHS.active} neo-intake · active`);
});

test("an exited session's card carries no roster line", () => {
  // The roster is what the harness reported it was running, and an exited session is running
  // nothing: the record's last report outlives the session, so drawing it would put a waiting-on
  // line with ages growing on every re-render under a header that says exited.
  const card = renderCard(view({ backgroundTasks: [agent("S6")] }), "exited", NOW);

  assert.ok(!card.includes("Waiting"), card);
  assert.equal(threadName(view({ backgroundTasks: [agent("S6")] }), "exited"), "⚠ neo-intake · exited");
});

test("a fan-out past the card's cap is counted rather than dropped, and the card still fits", () => {
  // The cap is pathological rather than cosmetic: a measured fan-out session peaked at twelve
  // concurrent agents, so nothing an operator sees is counted. What the count is for is a fan-out
  // no session here has produced, and the card carrying one still has to be a message Discord will
  // take, since one it refuses freezes the card at whatever it last said.
  for (const size of [25, 40, 200]) {
    const fleet = Array.from({ length: size }, (_unused, index) =>
      agent(`task-${index}`, {
        description: "a description long enough to fill the whole row by itself",
        agentType: "implementer-fable",
        since: NOW - (index + 1) * 60_000,
      }),
    );
    const card = renderCard(view({ backgroundTasks: fleet }), "working", NOW);
    const tasks = tasksOf(card);

    assert.equal(
      value(card, "State"),
      `working · ${String(size)} tasks`,
      "the size of the fan-out is on the state, whatever the block had room for",
    );
    const counted = tasks.at(-1) ?? "";
    assert.match(counted, /^\+\d+ more$/, tasks.join("\n"));
    // The oldest are the ones kept, since the newest arrivals are the ones a reader has not been
    // watching, and what is counted is exactly what was not drawn.
    assert.equal(tasks[0], `${span(size * 60_000)} · implementer-fable`);
    const named = (tasks.length - 1) / 2;
    assert.equal(counted, `+${String(size - named)} more`);
    assert.ok(card.length <= MAX_CARD_LENGTH, `${String(card.length)} units`);
    for (const line of bodyOf(card)) {
      assert.ok([...line].length <= MAX_BLOCK_WIDTH, line);
    }
  }
});

test("a card whose every field is at its cap still fits one message, roster included", () => {
  // The whole message is the binding constraint the block-per-section split does not relax: three
  // fences cost more delimiters than one, and a full roster at two rows an entry is a tall card.
  const fleet = Array.from({ length: 40 }, (_unused, index) =>
    agent(`task-${index}`, {
      description: "`".repeat(MAX_FIELD_LENGTH),
      agentType: "`".repeat(MAX_FIELD_LENGTH),
      since: NOW - (index + 1) * 60_000,
    }),
  );
  const card = renderCard(
    view({
      sessionId: "`".repeat(MAX_FIELD_LENGTH),
      name: "`".repeat(MAX_FIELD_LENGTH),
      host: "`".repeat(MAX_FIELD_LENGTH),
      lastTool: "`".repeat(MAX_FIELD_LENGTH),
      lastToolInput: "`".repeat(MAX_FIELD_LENGTH),
      model: "`".repeat(MAX_FIELD_LENGTH),
      openingModel: "claude-fable-5",
      contextTokens: 999_000,
      backgroundTasks: fleet,
    }),
    "working",
    NOW,
  );

  assert.ok(card.length <= MAX_CARD_LENGTH, `${String(card.length)} units`);
  assert.ok([...card].length <= MAX_CARD_LENGTH, `${String([...card].length)} characters`);
  assert.equal(value(card, "Heartbeat"), "just now", "the rows the card exists to carry survive it");
  assert.match(tasksOf(card).at(-1) ?? "", /^\+\d+ more$/);
});

test("a hostile task description is drawn as text, and cannot draw a chip or close the fence", () => {
  // The roster is inside the fence, where Discord renders no markdown and resolves no chip, so the
  // syntax reads as the characters it is; what a crafted description must not do is close the
  // block and put the rest of the card outside it.
  const card = renderCard(
    view({
      backgroundTasks: [
        agent("hostile", {
          description: "``` <t:20:R>",
          agentType: "#h",
        }),
      ],
    }),
    "working",
    NOW,
  );

  const delimiters = card.split("\n").filter((line) => line.includes("``"));
  assert.deepEqual(delimiters, ["```", "```", "```", "```", "```", "```"], card);
  assert.ok(card.includes("<t:20:R>"), "the chip syntax is characters inside the fence");
  assert.ok(card.includes("· #h"), "and so is the heading marker");
  assert.ok(card.length <= MAX_CARD_LENGTH, card);
});

test("a task with nothing to say about itself is named by its kind", () => {
  const blank = renderCard(
    view({ backgroundTasks: [agent("blank", { description: "   ", agentType: "   ", since: NOW })] }),
    "working",
    NOW,
  );
  const absent = renderCard(
    view({
      backgroundTasks: [agent("absent", { description: null, agentType: null, since: NOW - 60_000 })],
    }),
    "working",
    NOW,
  );

  // One row, not two: an entry with nothing to say about itself draws no empty second line.
  assert.deepEqual(tasksOf(blank), ["0m · subagent"]);
  assert.deepEqual(tasksOf(absent), ["1m · subagent"]);

  // Two of them on one card, both drawn: neither has a description to crowd the other's row,
  // because an entry no longer shares a row with anything.
  const both = renderCard(
    view({
      backgroundTasks: [
        agent("blank", { description: "   ", agentType: "   ", since: NOW }),
        agent("absent", { description: null, agentType: null, since: NOW - 60_000 }),
      ],
    }),
    "working",
    NOW,
  );
  assert.deepEqual(tasksOf(both), ["1m · subagent", "0m · subagent"]);
});

test("an entry's age and type are drawn whole, whatever the type is called", () => {
  // The age and the type are the two parts a reader cannot reconstruct, and the row they share
  // carries nothing else, so an agent type at its own cap is drawn whole rather than cut and the
  // description keeps a row of its own under it.
  const card = renderCard(
    view({
      backgroundTasks: [
        agent("wide", {
          description: "a description long enough to fill the whole row by itself",
          agentType: "a".repeat(32),
          since: NOW - 60_000,
        }),
      ],
    }),
    "working",
    NOW,
  );

  const tasks = tasksOf(card);
  assert.equal(tasks[0], `1m · ${"a".repeat(32)}`);
  assert.ok(tasks[1].startsWith("       a description long enough"), tasks[1]);
  for (const line of tasks) assert.ok([...line].length <= MAX_BLOCK_WIDTH, line);
});

test("the description row starts exactly two columns past the age row's own lead, with no separator", () => {
  const card = renderCard(
    view({
      backgroundTasks: [
        agent("indent", { description: "one task's own prose", since: NOW - 35 * 60_000 }),
      ],
    }),
    "working",
    NOW,
  );

  const tasks = tasksOf(card);
  // "35m · " is six code points; the description sits two past that, and carries no leading "·",
  // so the row reads as the entry above it continuing rather than as an entry of its own.
  assert.equal(tasks[1], "        one task's own prose");
  assert.ok(!tasks[1].includes("·"), tasks[1]);
});

test("a description at the cap keeps every roster row inside the block width", () => {
  const card = renderCard(
    view({
      backgroundTasks: [agent("capped", { description: "x".repeat(200), since: NOW - 60_000 })],
    }),
    "working",
    NOW,
  );

  const tasks = tasksOf(card);
  for (const line of tasks) assert.ok([...line].length <= MAX_BLOCK_WIDTH, line);
});
