// The interactive question message. Three properties carry the weight: what a tap can say is
// bounded by what the ask really offered, every field stays inside a Discord cap the maximum ask
// would otherwise blow, and a component id names an entry and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUESTIONS_PER_ASK } from "../tail.ts";
import {
  MAX_MESSAGE_LENGTH,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
} from "./render.ts";
import type { AskedOption, AskedQuestion } from "./render.ts";
import {
  CLOSED_NOTICE,
  MAX_ACTION_ROWS,
  MAX_BUTTONS_PER_ROW,
  MAX_BUTTON_LABEL_LENGTH,
  TYPED_ANSWER_FOOTER,
  answerableFromThread,
  autoSubmits,
  incompleteNotice,
  optionValue,
  parseComponentId,
  parseOptionValue,
  renderQuestionOutcome,
  renderQuestionPrompt,
} from "./question-message.ts";
import type { ActionRow } from "./question-message.ts";

const OPERATOR = "700000000000000002";
const ENTRY = "a1b2c3d4e5f6";

function options(...labels: string[]): AskedOption[] {
  return labels.map((label) => ({ label, description: null }));
}

function asked(overrides: Partial<AskedQuestion> = {}): AskedQuestion {
  return {
    question: "Ship the migration now?",
    header: null,
    multiSelect: false,
    options: options("Now", "After the backup"),
    ...overrides,
  };
}

/** The payload's own questions array for an ask the reader carried whole. */
function verbatim(questions: readonly AskedQuestion[]): unknown[] {
  return questions.map((question) => ({
    question: question.question,
    options: question.options.map((option) => ({ label: option.label })),
  }));
}

function prompt(questions: readonly AskedQuestion[], selections: string[][] = []) {
  return renderQuestionPrompt({
    operatorId: OPERATOR,
    entryId: ENTRY,
    questions,
    selections: selections.length > 0 ? selections : questions.map(() => []),
  });
}

/** Every component of a rendered message, flattened, for the cap assertions. */
function components(rows: readonly ActionRow[]): Array<Record<string, unknown>> {
  return rows.flatMap((row) => row.components as unknown as Array<Record<string, unknown>>);
}

test("a two-question ask renders a select each and one control row", () => {
  const { content, components: rows } = prompt([
    asked({ header: "Timing", options: options("Now", "After the backup") }),
    asked({
      question: "Which hosts get the change?",
      header: "Hosts",
      multiSelect: true,
      options: options("NEO", "TRINITY"),
    }),
  ]);

  assert.deepEqual(content.split("\n"), [
    `<@${OPERATOR}> ❓ **2 questions** · answer here or at the console`,
    "",
    "**1. Timing** · Ship the migration now?",
    "**2. Hosts** · Which hosts get the change? *(pick any)*",
    "",
    TYPED_ANSWER_FOOTER,
  ]);
  assert.equal(rows.length, 3, "one row per question, plus the control row");

  const [first, second] = rows;
  assert.deepEqual(first.components[0], {
    type: 3,
    custom_id: `qd:${ENTRY}:0`,
    placeholder: "Choose one",
    // Zero, so a choice made by accident can be cleared rather than only replaced. What holds the
    // submit guarantee is the desk, which names a question holding no value and submits nothing.
    min_values: 0,
    max_values: 1,
    options: [
      { label: "Now", value: "0" },
      { label: "After the backup", value: "1" },
    ],
  });
  assert.deepEqual(second.components[0], {
    type: 3,
    custom_id: `qd:${ENTRY}:1`,
    placeholder: "Choose any that apply",
    // Zero, so a choice made by accident can be cleared rather than only replaced. What holds the
    // submit guarantee is the desk, which names a question holding no value and submits nothing.
    min_values: 0,
    // A multi-select may take every option it has; a single-select takes exactly one.
    max_values: 2,
    options: [
      { label: "NEO", value: "0" },
      { label: "TRINITY", value: "1" },
    ],
  });
  assert.deepEqual(rows[2], {
    type: 1,
    components: [
      { type: 2, style: 1, label: "Send answers", custom_id: `qd:${ENTRY}:send` },
      { type: 2, style: 2, label: "Answer at console", custom_id: `qd:${ENTRY}:console` },
    ],
  });
  // The third way to answer, which no component on this message shows: a typed reply, which the
  // inbound router reads as the whole ask's answer for as long as the hold stands.
  assert.ok(content.endsWith(TYPED_ANSWER_FOOTER), content);
});

test("an option description rides in the select, and an absent one renders as absent", () => {
  const { components: rows } = prompt([
    asked({
      multiSelect: true,
      options: [
        { label: "Now", description: "the backup is an hour out" },
        { label: "After the backup", description: null },
      ],
    }),
  ]);

  assert.deepEqual((rows[0].components[0] as { options: unknown[] }).options, [
    { label: "Now", value: "0", description: "the backup is an hour out" },
    // No description key at all rather than an empty one: Discord refuses an empty description.
    { label: "After the backup", value: "1" },
  ]);
});

test("the operator's own choices come back as the menu's defaults", () => {
  // A client rebuilds a select from the message, so an ask whose message never says what is chosen
  // shows the placeholder again after every tap.
  const { components: rows } = prompt(
    [asked({ multiSelect: true, options: options("NEO", "TRINITY") })],
    [["TRINITY"]],
  );

  assert.deepEqual((rows[0].components[0] as { options: unknown[] }).options, [
    { label: "NEO", value: "0" },
    { label: "TRINITY", value: "1", default: true },
  ]);
});

test("a single single-select question with four options renders buttons and its descriptions", () => {
  // The fast path: one tap on a phone, and the descriptions the menu would have carried move into
  // the text, because a button has no room for one.
  const { content, components: rows } = prompt([
    asked({
      header: "Commit model",
      question: "Commit model for this effort?",
      options: [
        { label: "Commit-and-Push", description: "land on main as sections complete" },
        { label: "Review-Only", description: "staged, reviewed before commit" },
        { label: "Branch-and-PR", description: null },
      ],
    }),
  ]);

  assert.deepEqual(content.split("\n"), [
    `<@${OPERATOR}> ❓ **Waiting on you** · answer here or at the console`,
    "",
    "**Commit model** · Commit model for this effort?",
    "1. **Commit-and-Push** · land on main as sections complete",
    "2. **Review-Only** · staged, reviewed before commit",
    "3. **Branch-and-PR**",
    "",
    // Both layouts carry it: the typed answer is a property of the hold, not of how the ask drew.
    TYPED_ANSWER_FOOTER,
  ]);
  assert.equal(rows.length, 1, "the options and the release share one row");
  assert.deepEqual(rows[0].components, [
    { type: 2, style: 1, label: "Commit-and-Push", custom_id: `qd:${ENTRY}:0:0` },
    { type: 2, style: 1, label: "Review-Only", custom_id: `qd:${ENTRY}:0:1` },
    { type: 2, style: 1, label: "Branch-and-PR", custom_id: `qd:${ENTRY}:0:2` },
    { type: 2, style: 2, label: "Answer at console", custom_id: `qd:${ENTRY}:console` },
  ]);
});

test("the fast path is only for the ask that fits one row and answers with one tap", () => {
  // Four options plus the release button is exactly a row; a multi-select is never one tap, and a
  // second question needs a menu of its own.
  const four = prompt([asked({ options: options("a", "b", "c", "d") })]);
  assert.equal(four.components.length, 1);
  assert.equal(four.components[0].components.length, MAX_BUTTONS_PER_ROW);

  const multi = prompt([asked({ multiSelect: true, options: options("a", "b") })]);
  assert.equal(multi.components.length, 2, "a multi-select takes the select path and waits for Send");
  assert.equal(multi.components[0].components[0].type, 3);

  const two = prompt([asked(), asked({ question: "and the other one?" })]);
  assert.equal(two.components.length, 3);
});

test("the maximum ask stays inside every Discord cap it could blow", () => {
  // Four questions of four options, each field at a length no real call reaches: the row budget is
  // exactly spent, the field limits hold, and the text stays under the message ceiling, which the
  // notice's own 500-unit question cap would not have.
  const maximal = asked({
    question: "q".repeat(900),
    header: "h".repeat(150),
    multiSelect: true,
    options: ["a", "b", "c", "d"].map((letter) => ({
      label: letter.repeat(150),
      description: letter.repeat(150),
    })),
  });
  const { content, components: rows } = prompt([maximal, maximal, maximal, maximal]);

  assert.equal(rows.length, MAX_ACTION_ROWS, "four selects and the control row is the whole budget");
  assert.ok(content.length <= MAX_MESSAGE_LENGTH, `${String(content.length)} units of content`);
  // The fast path is the other half of the same ceiling, and the only one that draws an untrusted
  // string as a button: a select never renders on this ask, so the four-question fixture above
  // exercises no option label against the button limit at all.
  const buttons = prompt([{ ...maximal, multiSelect: false }]);
  assert.equal(buttons.components.length, 1);
  assert.ok(
    buttons.content.length <= MAX_MESSAGE_LENGTH,
    `${String(buttons.content.length)} units of content`,
  );

  for (const component of components([...rows, ...buttons.components])) {
    const label = component.label;
    // A button's label and a select option's label are different Discord fields with different
    // limits, and the whole message is refused when either is over its own.
    if (typeof label === "string") {
      assert.ok([...label].length <= MAX_BUTTON_LABEL_LENGTH, label);
    }
    for (const option of (component.options ?? []) as Array<Record<string, string>>) {
      assert.ok([...option.label].length <= MAX_OPTION_LABEL_LENGTH, option.label);
      assert.ok(
        [...(option.description ?? "")].length <= MAX_OPTION_DESCRIPTION_LENGTH,
        option.description,
      );
    }
  }
});

test("the ask's own ceiling and the row budget that has to hold it move together", () => {
  // The cross-component pin. The reader bounds an ask at four questions and this renderer spends
  // one row on each plus the control row, and neither constant can be raised without the other
  // silently composing a message Discord refuses whole.
  assert.equal(
    MAX_QUESTIONS_PER_ASK + 1,
    MAX_ACTION_ROWS,
    "one select per question and one control row is exactly Discord's row budget",
  );
});

test("untrusted text in a component is stripped and bounded but never escaped", () => {
  // The escape distinction this surface exists on either side of: a component renders plain text,
  // so a backslash written in front of an asterisk would reach the operator as a backslash, while
  // the message text around it is markdown and escapes normally.
  const invisible = String.fromCharCode(0x200b, 0x202e);
  const { content, components: rows } = prompt([
    asked({
      question: "**bold** <@999999999999999999>",
      multiSelect: true,
      options: [{ label: `a*b_c <@1> ${invisible}`, description: `> quoted ${invisible}` }],
    }),
  ]);

  const option = (rows[0].components[0] as unknown as { options: Array<Record<string, string>> })
    .options[0];
  assert.equal(option.label, "a*b_c <@1>", "no escape, and the invisible class gone");
  assert.equal(option.description, "> quoted");
  const mentions = [...content.matchAll(/(?<!\\)<@/g)];
  assert.equal(mentions.length, 1, "the only unescaped mention in the text is the broker's own");

  // The other half of the same rule: a fast-path button's label is untouched markdown too.
  const buttons = prompt([asked({ options: [{ label: "a*b_c", description: null }] })]);
  assert.deepEqual(buttons.components[0].components[0], {
    type: 2,
    style: 1,
    label: "a*b_c",
    custom_id: `qd:${ENTRY}:0:0`,
  });
});

test("an ask with an unreadable option cannot be answered from the thread", () => {
  // No option is no select and no button, so the ask would be parked behind components that never
  // complete. The caller's answer is the plain notice and a released hold.
  assert.equal(answerableFromThread([asked()], verbatim([asked()])), true);
  assert.equal(answerableFromThread([asked({ options: [] })], verbatim([asked({ options: [] })])), false);
  const unreadable = [asked(), asked({ options: options("​") })];
  assert.equal(
    answerableFromThread(unreadable, verbatim(unreadable)),
    false,
    "a label that neutralizes to nothing is not an option",
  );
  assert.equal(answerableFromThread([], []), false);
});

test("an ask the bounded parse did not carry whole cannot be answered from the thread", () => {
  // The answers map is built over the parse and the session reads it against the input it wrote, so
  // a parse that dropped a question would answer with a map missing a key for a question the tool
  // asked. A parse that dropped an option is the other half: the thread would offer fewer choices
  // than the console does, and the operator would pick from a list they had no way to know was cut.
  const four = [asked(), asked({ question: "b" }), asked({ question: "c" }), asked({ question: "d" })];
  assert.equal(answerableFromThread(four, verbatim(four)), true);
  assert.equal(
    answerableFromThread(four, [...verbatim(four), { question: "e", options: [{ label: "Now" }] }]),
    false,
    "a fifth question the reader dropped is a fifth question the session still asked",
  );

  const cut = asked({ options: options("a", "b", "c", "d") });
  assert.equal(
    answerableFromThread(
      [cut],
      [{ question: cut.question, options: [...options("a", "b", "c", "d"), { label: "e" }] }],
    ),
    false,
    "a fifth option the reader dropped is a choice the console still offers",
  );
});

test("two questions asked in the same words cannot be answered from the thread", () => {
  // The answers map is keyed by the question text itself, so a second question of the same text has
  // no key of its own: one answer would silently stand for both.
  const twice = [asked(), asked()];
  assert.equal(answerableFromThread(twice, verbatim(twice)), false);
});

test("a component id round-trips, and nothing else resolves to one", () => {
  const single = prompt([asked()]);
  const selects = prompt([asked(), asked({ multiSelect: true })]);

  assert.deepEqual(parseComponentId(single.components[0].components[0].custom_id as string), {
    entryId: ENTRY,
    action: { kind: "answer", questionIndex: 0, optionIndex: 0 },
  });
  assert.deepEqual(parseComponentId(selects.components[1].components[0].custom_id as string), {
    entryId: ENTRY,
    action: { kind: "answer", questionIndex: 1, optionIndex: null },
  });
  assert.deepEqual(parseComponentId(`qd:${ENTRY}:send`), {
    entryId: ENTRY,
    action: { kind: "send" },
  });
  assert.deepEqual(parseComponentId(`qd:${ENTRY}:console`), {
    entryId: ENTRY,
    action: { kind: "console" },
  });

  for (const forged of [
    "",
    "qd",
    `qd:${ENTRY}`,
    `qd::0`,
    `other:${ENTRY}:0`,
    `qd:${ENTRY}:0:1:2`,
    `qd:${ENTRY}:x`,
    `qd:${ENTRY}:0:y`,
    `qd:${ENTRY}:-1`,
    `qd:${ENTRY}:1e3`,
    `qd:${ENTRY}:0000`,
  ]) {
    assert.equal(parseComponentId(forged), null, forged);
  }
});

test("a single-select-only ask submits on its last tap; anything multi waits for Send", () => {
  const singles = [asked(), asked({ question: "second" })];
  assert.equal(autoSubmits(singles, [[], []]), false);
  assert.equal(autoSubmits(singles, [["Now"], []]), false);
  assert.equal(autoSubmits(singles, [["Now"], ["Now"]]), true);

  const withMulti = [asked(), asked({ question: "second", multiSelect: true })];
  assert.equal(
    autoSubmits(withMulti, [["Now"], ["Now"]]),
    false,
    "the operator may still be choosing, and one option is not the several they meant",
  );
});

test("a select's option value round-trips through the pair that owns its format", () => {
  // The writer and the reader of this value live in one module deliberately: each tested only
  // against its own literal is how a mismatch between them stays invisible.
  const { components: rows } = prompt([asked({ multiSelect: true, options: options("a", "b") })]);
  const values = (
    rows[0].components[0] as unknown as { options: Array<Record<string, string>> }
  ).options.map((option) => option.value);

  assert.deepEqual(values, [optionValue(0), optionValue(1)]);
  assert.deepEqual(values.map((value) => parseOptionValue(value)), [0, 1]);
  for (const forged of ["", "x", "-1", "1e3", "0000", " 1"]) {
    assert.equal(parseOptionValue(forged), null, forged);
  }
});

test("the notices this surface speaks are the ones the router hands back", () => {
  assert.equal(incompleteNotice(2), "Question 2 is not answered yet.");
  assert.equal(CLOSED_NOTICE, "That question is no longer open.");
});

test("every terminal state rewrites the message, and the answered one carries what was sent", () => {
  const questions = [
    asked({ header: "Timing" }),
    asked({ question: "Which hosts?", header: "Hosts", multiSelect: true }),
  ];

  assert.deepEqual(
    renderQuestionOutcome({
      state: "answered",
      questions,
      answers: { "Ship the migration now?": "Now", "Which hosts?": ["NEO", "TRINITY"] },
      response: null,
    }).split("\n"),
    ["✅ **Answered from the thread**", "**Timing** · Now", "**Hosts** · NEO, TRINITY"],
  );

  assert.equal(
    renderQuestionOutcome({
      state: "answered",
      questions,
      answers: null,
      response: "in my own words",
    }),
    "✅ **Answered from the thread**\nin my own words",
  );

  const closed = (state: "released" | "expired" | "client-gone" | "shutdown"): string[] =>
    renderQuestionOutcome({ state, questions, answers: null, response: null }).split("\n");

  // Every release state carries the questions on: this edit replaces the thread's only copy of
  // them, and the console the operator is being sent to is where they are.
  const titles = ["**1. Timing** · Ship the migration now?", "**2. Hosts** · Which hosts?"];
  assert.deepEqual(closed("released"), [
    "❓ **Question closed** · released to the console, answer it at the console",
    ...titles,
  ]);
  assert.deepEqual(closed("expired"), [
    "❓ **Question closed** · the hold expired, answer it at the console",
    ...titles,
  ]);
  assert.deepEqual(closed("client-gone"), [
    "❓ **Question closed** · the session stopped waiting, answer it at the console",
    ...titles,
  ]);
  assert.deepEqual(closed("shutdown"), [
    "❓ **Question closed** · the broker restarted, answer it at the console",
    ...titles,
  ]);
  assert.deepEqual(
    renderQuestionOutcome({
      state: "expired",
      questions: [asked({ header: "Timing" })],
      answers: null,
      response: null,
    }).split("\n"),
    [
      "❓ **Question closed** · the hold expired, answer it at the console",
      "**Timing** · Ship the migration now?",
    ],
    "a single question is not numbered, exactly as the fast path draws it",
  );

  // The console's own answer, which lands after one of the release states above has already
  // rewritten this message: it carries no instruction, because the picker it was pointing at has
  // been answered, and no answer, because the console's picks reach this broker nowhere.
  assert.deepEqual(
    renderQuestionOutcome({
      state: "answered-at-console",
      questions,
      answers: null,
      response: null,
    }).split("\n"),
    ["✅ **Answered at the console**", ...titles],
  );
});

test("a question named like a prototype key renders its answer and never the prototype", () => {
  // Question text is untrusted conversation content and the answers map is keyed by it, so a
  // question asked as `__proto__` reaches the lookup below as a key every plain object already
  // answers. Read as an own property or not at all: a prototype read here is an object where a
  // label was expected, and a throw out of this render is a message that never closes out.
  const questions = [asked({ question: "__proto__", header: "Timing" })];
  const answers = JSON.parse('{"__proto__":"Now"}') as Record<string, string>;

  assert.deepEqual(
    renderQuestionOutcome({ state: "answered", questions, answers, response: null }).split("\n"),
    ["✅ **Answered from the thread**", "**Timing** · Now"],
  );
  assert.equal(
    renderQuestionOutcome({ state: "answered", questions, answers: {}, response: null }),
    "✅ **Answered from the thread**",
    "an answers map carrying nothing for the question renders no line for it",
  );
});

test("an answer rendered back into the thread is escaped like every other untrusted field", () => {
  // The submitted labels land in message content, which is markdown, so this is the one place a
  // question's own text goes back through the escaping helper rather than the component one.
  const text = renderQuestionOutcome({
    state: "answered",
    questions: [asked({ header: "<@999999999999999999>" })],
    answers: { "Ship the migration now?": "> **now** <@1>" },
    response: null,
  });

  assert.ok(!/(?<!\\)<@/.test(text), text);
  assert.ok(!text.includes("**now**"), text);
});
