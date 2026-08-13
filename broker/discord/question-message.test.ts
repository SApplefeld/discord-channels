// The interactive question message. Three properties carry the weight: what a tap can say is
// bounded by what the ask really offered, every field stays inside a Discord cap the maximum ask
// would otherwise blow, and a component id names an entry and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUESTIONS_PER_ASK } from "../tail.ts";
import {
  MAX_HELD_DESCRIPTION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
} from "./render.ts";
import type { AskedOption, AskedQuestion } from "./render.ts";
import {
  CLOSED_NOTICE,
  MAX_ACTION_ROWS,
  MAX_BODY_DESCRIPTION_LENGTH,
  MAX_BUTTONS_PER_ROW,
  MAX_BUTTON_LABEL_LENGTH,
  MAX_CONTINUATION_MESSAGES,
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

/**
 * Whether some continuation carries this exact text as a whole line. Line identity is the no-cut
 * guarantee: an option present only as a prefix of itself is a decision made on half a sentence.
 */
function carriesLine(continuations: readonly string[], line: string): boolean {
  return continuations.some((message) => message.split("\n").includes(line));
}

/** A plain gloss long enough that a handful of them outgrow one message. */
function longGloss(seed: string): string {
  return `${seed} `.repeat(650).trim();
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

  // Every question draws its options in the body, not only in the menu it is answered through. The
  // menu caps a label and a description at a hundred units each and a phone ellipsizes what is left
  // inside it, so a menu is the picker and this is the reading copy.
  assert.deepEqual(content.split("\n"), [
    `<@${OPERATOR}> ❓ **2 questions** · answer here or at the console`,
    "",
    "**1. Timing** · Ship the migration now?",
    "1. **Now**",
    "2. **After the backup**",
    "",
    "**2. Hosts** · Which hosts get the change? *(pick any)*",
    "1. **NEO**",
    "2. **TRINITY**",
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

test("a question gets the room it wants wherever the message can carry it", () => {
  // The share is what each question asked for, not a slice of the count. Two questions, one wanting
  // far more than the other: an equal split would spill the big one while the small one sat on room
  // it never wanted, and the whole message would still be nowhere near the ceiling.
  const gloss = (n: number): string => `${"a reason the option is worth taking, ".repeat(n)}and so on`;
  const big = asked({
    header: "Big",
    question: "The question with four long options?",
    options: [1, 2, 3, 4].map((n) => ({ label: `Option ${String(n)}`, description: gloss(9) })),
  });
  const small = asked({ header: "Small", question: "Short?", options: options("Yes", "No") });

  const { content } = prompt([big, small]);

  assert.ok(content.length <= MAX_MESSAGE_LENGTH, `${String(content.length)} units of content`);
  // Every option of both questions drawn, gloss and all, and no marker: the message had the room,
  // and the room was where it was wanted.
  for (const n of [1, 2, 3, 4]) assert.ok(content.includes(`**Option ${String(n)}**`), content);
  assert.equal((content.match(/_\(/g) ?? []).length, 0, content);
  assert.ok(content.includes(gloss(9)), "the long gloss rides whole");
});

test("no shape of ask composes a prompt past the message ceiling", () => {
  // The split makes the bound arithmetic over what the questions wanted rather than over the count,
  // so it is worth proving over shapes rather than reasoning about one. Every combination of counts,
  // option counts, and field widths, at the caps and past them.
  const wide = "w".repeat(2_000);
  let worst = 0;
  for (const count of [1, 2, 3, 4]) {
    for (const optionCount of [0, 1, 2, 4]) {
      for (const multiSelect of [false, true]) {
        const questions = Array.from({ length: count }, (_, at) =>
          asked({
            question: `${String(at)} ${wide}`,
            header: wide,
            multiSelect,
            options: Array.from({ length: optionCount }, (_, n) => ({
              label: `${String(n)} ${wide}`,
              description: wide,
            })),
          }),
        );
        const { content, components: rows } = prompt(questions);
        worst = Math.max(worst, content.length);
        assert.ok(
          content.length <= MAX_MESSAGE_LENGTH,
          `${String(count)}q ${String(optionCount)}opt multi=${String(multiSelect)} composed ${String(content.length)}`,
        );
        assert.ok(rows.length <= MAX_ACTION_ROWS, `${String(rows.length)} rows`);
      }
    }
  }
  // Reported so a change that quietly spends the remaining slack is visible as a number rather than
  // only as the day the ceiling is finally crossed.
  assert.ok(worst > 0 && worst <= MAX_MESSAGE_LENGTH, `worst observed ${String(worst)}`);
});

test("a terminal state names every question of a maximal ask, inside one message", () => {
  // These branches carry titles and nothing else, and they enforce no bound of their own. Nothing
  // downstream fails loudly for them either: the writer neutralizes through `inertMessage`, which
  // cuts to the ceiling rather than refusing, so a message composed past it posts with its tail
  // eaten and no marker saying so. The tail is the later questions, on the one message whose job is
  // telling the operator what is waiting at a console. So the bound is this renderer's to hold.
  const long = (n: number): AskedQuestion =>
    asked({
      question: `Question ${String(n)} ${"and some more of the question text ".repeat(20)}`,
      header: `Header ${String(n)} ${"H".repeat(90)}`,
    });
  const questions = [long(1), long(2), long(3), long(4)];

  for (const state of ["released", "expired", "client-gone", "shutdown", "answered-at-console"] as const) {
    const text = renderQuestionOutcome({ state, questions, answers: null, response: null });
    assert.ok(
      text.length <= MAX_MESSAGE_LENGTH,
      `${state} composed ${String(text.length)} units against ${String(MAX_MESSAGE_LENGTH)}`,
    );
    // Every question named, not just the ones that happened to fit. A closing message that drops
    // question 4 sends the operator to a console holding a question the thread never mentioned.
    for (const n of [1, 2, 3, 4]) {
      assert.ok(text.includes(`Question ${String(n)} `), `${state} lost question ${String(n)}`);
    }
  }
});

test("a description too long for a select menu still reaches the body whole", () => {
  // The whole point of drawing options in the body. Two thirds of the descriptions real
  // AskUserQuestion calls carry run past Discord's hundred-unit ceiling on a select option's
  // description, and the median runs to about 160, so the menu is where an option's reasoning goes
  // to be cut. The body has no such ceiling and wraps to the reader's own window.
  const reasoning = `it ${"costs a rebuild and a re-run of the whole suite, ".repeat(6)}so it is slow`;
  assert.ok(
    reasoning.length > MAX_OPTION_DESCRIPTION_LENGTH * 2,
    "the fixture has to be past the menu's ceiling for this to prove anything",
  );

  const { content, components: rows } = prompt([
    asked({ multiSelect: true, options: [{ label: "Rebuild", description: reasoning }] }),
  ]);

  // Multi-select, so this is the menu path: the layout that carried its options nowhere but inside
  // the component before.
  assert.equal(rows[0].components[0].type, 3, "a multi-select is answered through a menu");
  assert.ok(content.includes(reasoning), content);

  // And the menu still holds its own field to Discord's limit, because a message with one field
  // over it is refused whole. The two are different widths of the same text, which is exactly why
  // the reader keeps it at neither.
  const [option] = (rows[0].components[0] as unknown as { options: Array<{ description: string }> })
    .options;
  assert.equal([...option.description].length, MAX_OPTION_DESCRIPTION_LENGTH);
  assert.ok(reasoning.startsWith(option.description.slice(0, -1)), option.description);
  assert.ok(content.length <= MAX_MESSAGE_LENGTH, `${String(content.length)} units of content`);
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

test("an ask that fits one message yields no continuations, on both layouts", () => {
  // The common case, which must not grow follow-up posts: the exact bytes of these fixtures are
  // pinned by the tests above, so what this locks is that a fitting ask posts nothing extra and
  // carries no marker pointing at messages that do not exist.
  const selects = prompt([
    asked({ header: "Timing" }),
    asked({ question: "Which hosts get the change?", multiSelect: true }),
  ]);
  assert.deepEqual(selects.continuations, []);
  assert.ok(!selects.content.includes("_("), selects.content);

  const buttons = prompt([asked()]);
  assert.deepEqual(buttons.continuations, []);
  assert.ok(!buttons.content.includes("_("), buttons.content);
});

test("a spilled option's whole gloss rides a continuation, split only at line boundaries", () => {
  // The defect this surface exists to close: an option the body had no room for used to be
  // readable only inside the menu, cut to a hundred units. Four options wanting far more than one
  // message pushes three of them below, and each arrives as the exact line the body would have
  // drawn, however many messages the block has to span.
  const glosses = ["a", "b", "c", "d"].map((seed) => longGloss(seed));
  const { content, continuations } = prompt([
    asked({
      multiSelect: true,
      options: glosses.map((gloss, at) => ({
        label: `Option ${String(at + 1)}`,
        description: gloss,
      })),
    }),
  ]);

  // The body draws what fits and marks the rest as held whole below, never as menu content.
  assert.ok(content.includes(`1. **Option 1** · ${glosses[0]}`), content.slice(0, 200));
  assert.ok(content.includes("_(+3 more, in full below or at the console)_"), content);
  assert.ok(!content.includes(glosses[1]), "a spilled gloss is not in the body");

  // Every spilled option reads whole below, as the exact line the body composer writes: the block
  // outgrows one message, so it spans several, and no line is cut to make one fit.
  for (const [at, gloss] of glosses.entries()) {
    assert.ok(
      carriesLine(continuations, `${String(at + 1)}. **Option ${String(at + 1)}** · ${gloss}`),
      `option ${String(at + 1)} is not whole in any continuation`,
    );
  }
  assert.ok(continuations.length >= 2, `${String(continuations.length)} messages for a 5,300-unit block`);
  for (const message of continuations) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${String(message.length)} units`);
    // Every message carries the broker's own framing, `ATTRIBUTION`'s rule for split replies: a
    // message scrolled to on a phone opens on the broker's words, never on model-chosen text
    // drawn bold in the channel where approvals are answered.
    assert.ok(message.startsWith("❓ **Question continued from above**\n"), message.slice(0, 60));
  }
  // Under the cap there is no overflow tail: every option is drawn, so there is nothing to count.
  assert.ok(!continuations.join("\n").includes("not drawn here"), continuations.join("\n"));
});

test("a question whose own text is cut in the body continues whole below", () => {
  // The other way a block is held back: not an option that would not fit, but the question text
  // itself, which `titleRoom` narrows inside a tight share. A cut question with no marker and no
  // continuation is a question the operator answers from its front third without knowing it.
  const question = `Should we ${"weigh the cost carefully ".repeat(58)}and then decide`.padEnd(
    1_500,
    "?",
  );
  assert.equal([...question].length, 1_500, "the fixture sits exactly at the question cap");

  // One question at the cap with one short option: the body cannot carry the title whole even
  // with the whole message to itself.
  const single = prompt([asked({ question, options: options("Yes") })]);
  assert.ok(
    single.content.includes("_(question continued in full below or at the console)_"),
    single.content.slice(-200),
  );
  assert.ok(!single.content.includes(question), "the body's copy is cut");
  assert.ok(
    single.continuations.join("\n").includes(question),
    "the whole question text reads in a continuation",
  );

  // Four of them: each share is a quarter of the message, so each question draws a fraction of
  // itself in the body, and all four must continue below. Shorter than the cap by more than the
  // numbering prefix, so the continuation's own readability bound is not what cuts them.
  const wide = (n: number): string =>
    `Q${String(n)} ${"weigh the cost carefully ".repeat(55)}and then decide?`;
  const four = prompt(
    [1, 2, 3, 4].map((n) => asked({ question: wide(n), options: options(`Yes to ${String(n)}`) })),
  );
  const joined = four.continuations.join("\n");
  for (const n of [1, 2, 3, 4]) {
    assert.ok(joined.includes(wide(n)), `question ${String(n)} is not whole below`);
  }
  for (const message of four.continuations) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${String(message.length)} units`);
    assert.ok(message.startsWith("❓ **Question continued from above**\n"), message.slice(0, 60));
  }
});

test("the fast path's marker sends the notes below, and the continuation carries them", () => {
  // The buttons already show every option's label, so what the fast layout withholds is only the
  // gloss beside a label, and its marker says exactly that. The continuation still redraws the
  // whole block, labels included, so it reads on its own.
  const rebuild = longGloss("r");
  const patch = longGloss("p");
  const { content, components: rows, continuations } = prompt([
    asked({
      options: [
        { label: "Rebuild", description: rebuild },
        { label: "Patch", description: patch },
      ],
    }),
  ]);

  assert.equal(rows.length, 1, "two options and the release button share one row");
  assert.ok(
    content.includes("_(+1 more on the buttons, notes in full below or at the console)_"),
    content,
  );
  assert.ok(!content.includes(patch), "the spilled gloss is not in the body");
  assert.ok(carriesLine(continuations, `2. **Patch** · ${patch}`), "the spilled note reads whole below");
  for (const message of continuations) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${String(message.length)} units`);
  }
});

test("a marker rides exactly the questions a continuation carries", () => {
  // A continuation repeats nothing that drew whole: the operator scrolling below the prompt finds
  // the spilled question in full and not a second copy of the one they already read.
  const big = asked({
    header: "Big",
    question: "The one whose options outgrow the message?",
    options: ["a", "b", "c", "d"].map((seed, at) => ({
      label: `Option ${String(at + 1)}`,
      description: longGloss(seed),
    })),
  });
  const small = asked({ header: "Small", question: "Short?", options: options("Yes", "No") });
  const { content, continuations } = prompt([big, small]);

  const marks = (content.match(/in full below or at the console/g) ?? []).length;
  assert.equal(marks, 1, "one marker, on the one question that spilled");
  const joined = continuations.join("\n");
  assert.ok(joined.includes("**1. Big**"), "the spilled question is redrawn whole, number and all");
  assert.ok(!joined.includes("**2. Small**"), "the question that drew whole is not repeated");
  assert.ok(!joined.includes("**Yes**"), joined.slice(0, 200));
});

test("a continuation escapes untrusted content exactly as the body does", () => {
  // A continuation lands in the channel where tool approvals are answered, so an unescaped field
  // there is a forgery surface: a mention pill, a live link, a quote bar. Every field reaches a
  // continuation through the same composer as the body, which is what these lock.
  const hostile = "@everyone [x](https://evil.example) <@999999999999999999> **bold** ".repeat(12);
  const { content, continuations } = prompt([
    asked({
      multiSelect: true,
      options: [
        { label: "Safe", description: `f ${"filler ".repeat(128)}`.trim() },
        { label: "Risky", description: hostile },
      ],
    }),
  ]);

  assert.ok(!content.includes("@everyone"), "the hostile option spilled out of the body");
  const joined = continuations.join("\n");
  assert.ok(joined.includes("Risky"), "the spilled option is below");
  // Markdown arrives escaped, so it renders as the characters it contains rather than as syntax.
  assert.ok(joined.includes("\\[x\\]\\(https://evil.example\\)"), joined.slice(0, 300));
  assert.ok(joined.includes("\\*\\*bold\\*\\*"), joined.slice(0, 300));
  // No unescaped mention syntax at all: the broker's own mention rides the interactive message,
  // never a continuation. `@everyone` survives as text on purpose; the transport's
  // `allowed_mentions` is what stops it pinging, exactly as in the body.
  assert.equal([...joined.matchAll(/(?<!\\)<@/g)].length, 0, joined.slice(0, 300));
  assert.ok(joined.includes("@everyone"), joined.slice(0, 300));
});

test("the adversarial maximum ends inside the cap, with the honest overflow tail", () => {
  // Four questions of four options with every field pinned at its anti-abuse cap compose tens of
  // thousands of units, several times the continuation budget. The fixture is markdown-heavy on
  // purpose: escaping expands it, so this walks the escape-then-bound path with hostile input
  // rather than plain filler of the right length.
  const hostile = (seed: string): string => `${seed}\`*_<>[]|~ `.repeat(200);
  const maximal = (n: number): AskedQuestion =>
    asked({
      question: hostile(`q${String(n)}`),
      header: hostile(`h${String(n)}`),
      multiSelect: true,
      options: [1, 2, 3, 4].map((o) => ({
        label: hostile(`l${String(n)}${String(o)}`),
        description: hostile(`d${String(n)}${String(o)}`),
      })),
    });
  const { content, continuations } = prompt([maximal(1), maximal(2), maximal(3), maximal(4)]);

  assert.ok(content.length <= MAX_MESSAGE_LENGTH, `${String(content.length)} units of content`);
  assert.equal(continuations.length, MAX_CONTINUATION_MESSAGES);
  for (const message of continuations) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${String(message.length)} units`);
  }
  // The last message ends by counting what was not drawn and naming the surface that has it all;
  // no earlier message carries the tail, because until the cap bites there is nothing to count.
  assert.match(
    continuations[continuations.length - 1],
    /_\(\+\d+ more options are not drawn here, read the ask in full at the console\)_$/,
  );
  for (const message of continuations.slice(0, -1)) {
    assert.ok(!message.includes("not drawn here"), message.slice(-200));
  }
});

test("the overflow tail rides inside the last message's ceiling, not past it", () => {
  // The tail's room has to be held back while the last allowed message is packed: appended after
  // the packer has filled it, the one message whose job is honesty is the one Discord refuses.
  // The glosses here are sized so two option lines fill a message to within less than a tail's
  // width of the ceiling, which is exactly the shape where reserving late instead of early breaks.
  const gloss = (seed: string): string => `${seed} `.repeat(294).trim();
  const dense = (n: number): AskedQuestion =>
    asked({
      question: `Q${String(n)}?`,
      header: `H${String(n)}`,
      multiSelect: true,
      options: ["a", "b", "c", "d"].map((seed, at) => ({
        label: `Option ${String(at + 1)}`,
        description: gloss(`${seed}${String(n)}`),
      })),
    });
  const { continuations } = prompt([dense(1), dense(2), dense(3), dense(4)]);

  assert.equal(continuations.length, MAX_CONTINUATION_MESSAGES);
  for (const message of continuations) {
    assert.ok(message.length <= MAX_MESSAGE_LENGTH, `${String(message.length)} units`);
    // A separator lands between drawn lines only: a message opening or closing on a blank line is
    // a separator whose other side went to a different message.
    assert.ok(!message.startsWith("\n") && !message.endsWith("\n"), JSON.stringify(message.slice(-40)));
  }
  assert.match(
    continuations[continuations.length - 1],
    /_\(\+\d+ more options are not drawn here, read the ask in full at the console\)_$/,
  );
});

test("the refinement round restores a block missing exactly one option", () => {
  // A drawn block that ends on a marker carries one line more than its options, and the round
  // that hands unspent room back has to count options, not lines: counting the marker as an
  // option reads a block missing exactly one as whole and skips it, leaving that option below
  // when the message had the room all along. The first question here misses exactly one option
  // whose line the spare covers; the second misses one the spare cannot cover, so it stays below.
  const first = asked({
    header: "One",
    question: "Pick the first lane?",
    options: [
      { label: "Alpha", description: "a ".repeat(290).trim() },
      { label: "Beta", description: "b ".repeat(90).trim() },
    ],
  });
  const second = asked({
    header: "Two",
    question: "Pick the second lane?",
    options: [
      { label: "Gamma", description: "c ".repeat(290).trim() },
      { label: "Delta", description: "d ".repeat(110).trim() },
    ],
  });
  const third = asked({ header: "Three", question: "Short?", options: options("Yes", "No") });
  const { content, continuations } = prompt([first, second, third]);

  assert.ok(content.length <= MAX_MESSAGE_LENGTH, `${String(content.length)} units of content`);
  assert.ok(
    content.includes(`2. **Beta** · ${"b ".repeat(90).trim()}`),
    "the returned room draws the one option the marker replaced",
  );
  assert.equal((content.match(/_\(/g) ?? []).length, 1, "one marker, on the one question still held back");
  const joined = continuations.join("\n");
  assert.ok(!joined.includes("**1. One**"), "the restored question is not repeated below");
  assert.ok(joined.includes("**2. Two**"), "the question still held back rides below");
  assert.ok(!joined.includes("**3. Three**"), joined.slice(0, 200));
});

test("re-rendering with selections redraws identical text and identical continuations", () => {
  // Continuations are posted once and never edited, so every tap-refresh of the interactive
  // message must compose the same text and the same markers: a selection reaches the picker's
  // defaults and nothing else.
  const question = asked({
    multiSelect: true,
    options: ["a", "b", "c", "d"].map((seed, at) => ({
      label: `Option ${String(at + 1)}`,
      description: longGloss(seed),
    })),
  });
  const blank = prompt([question]);
  const chosen = prompt([question], [["Option 2"]]);

  assert.equal(chosen.content, blank.content);
  assert.deepEqual(chosen.continuations, blank.continuations);
  // And the selection really landed, so the identity above is not two renders that both ignored it.
  const menu = chosen.components[0].components[0] as unknown as {
    options: Array<{ default?: boolean }>;
  };
  assert.equal(menu.options[1].default, true);
});

test("the intake bound on a description and the body's reading cap move together", () => {
  // The cross-component pin. Intake bounds a description with a bare slice (`sliceCodePoints`,
  // no ellipsis) before any renderer sees it, and this renderer marks its own cuts by ending the
  // block on a marker. A held bound below the reading cap would make intake the narrower cut and
  // the silent one: a description between the two would arrive cut mid-sentence and be drawn in
  // the body and the continuation looking whole.
  assert.ok(
    MAX_HELD_DESCRIPTION_LENGTH >= MAX_BODY_DESCRIPTION_LENGTH,
    `held ${String(MAX_HELD_DESCRIPTION_LENGTH)} is narrower than drawn ${String(MAX_BODY_DESCRIPTION_LENGTH)}`,
  );
});

test("the widest line the caps can compose still fits a continuation message", () => {
  // The packer places a first line into an empty message unchecked, so "no line is ever cut"
  // rests on the field caps keeping every composable line inside a message's room after the
  // framing line. This pins that relationship at the maximal shapes: a cap raised past what one
  // message carries goes red here rather than as a refused post in production.
  const over = "x".repeat(2_000);
  const maximal = asked({
    question: over,
    header: over,
    multiSelect: true,
    options: [1, 2, 3, 4].map((n) => ({ label: `${String(n)} ${over}`, description: over })),
  });
  const { continuations } = prompt([maximal, maximal, maximal, maximal]);

  assert.ok(continuations.length > 0, "the maximal ask spills");
  for (const message of continuations) {
    const [framing, ...rest] = message.split("\n");
    for (const line of rest) {
      assert.ok(
        framing.length + 1 + line.length <= MAX_MESSAGE_LENGTH,
        `a ${String(line.length)}-unit line cannot ride one message with the framing`,
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

test("a multi-select answer is bounded as the list it is, not as one label", () => {
  // The desk submits a multi-select answer as its labels joined with a comma and a space, which is
  // the text the console's own picker produces. That makes one string out of what used to be
  // several, so the room it is drawn in is the list's room: every option the ask offered at the
  // per-label ceiling, with the separators between them. Three realistic labels is where the
  // single-label ceiling bites.
  const labels = [
    "Jalapeños on the left half only",
    "Mushrooms across the whole pie",
    "Pepperoni, but only under the cheese please",
  ];
  const questions = [
    asked({ header: "Toppings", multiSelect: true, options: options(...labels) }),
  ];

  const text = renderQuestionOutcome({
    state: "answered",
    questions,
    answers: { "Ship the migration now?": labels.join(", ") },
    response: null,
  });

  assert.ok(text.includes(labels.join(", ")), text);
  assert.ok(!text.includes("…"), `nothing realistic is ellipsized: ${text}`);
});

test("a close-out message stays inside one message, whatever the ask offered", () => {
  // The close-out goes straight to an edit rather than through the writer's own cut, and Discord
  // refuses a message over its limit whole, which would leave the components live on a hold that
  // has already ended. So the answers are appended whole and the first that will not fit ends the
  // message with a count of the rest.
  const labels = Array.from({ length: 25 }, (_unused, at) => `option ${String(at)} `.repeat(12));
  const questions = Array.from({ length: 4 }, (_unused, at) =>
    asked({
      question: `Question ${String(at)}`,
      header: `Header ${String(at)}`,
      multiSelect: true,
      options: options(...labels),
    }),
  );
  const answers = Object.fromEntries(
    questions.map((question) => [question.question, labels.join(", ")]),
  );

  const text = renderQuestionOutcome({ state: "answered", questions, answers, response: null });

  assert.ok(text.length <= MAX_MESSAGE_LENGTH, `${String(text.length)} units`);
  assert.match(text, /\(\+\d+ more answered\)$/);

  // The bound is tested before the first answer is drawn, not only between them: a list's room
  // grows with the options the ask offered, so one question alone can ask for more than a message
  // carries, and a close-out that drew it whole would be refused rather than shortened. Past what
  // the transcript reader admits (four questions, four options each), so this is the module holding
  // its own bound rather than the reader's cap holding it for them.
  const alone = renderQuestionOutcome({
    state: "answered",
    questions: [questions[0]],
    answers: { [questions[0].question]: labels.join(", ") },
    response: null,
  });
  assert.equal(alone, "✅ **Answered from the thread**\n(+1 more answered)");
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
