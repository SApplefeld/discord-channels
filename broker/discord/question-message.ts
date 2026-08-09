// The interactive question message: what a question the desk is holding looks like in the thread,
// and how a tap on it comes back.
//
// One message per ask. The text carries the mention and a numbered title line per question, and the
// components carry the answering: a string select per question, or, for the single-question ask
// small enough to fit one row, the options themselves as buttons so the phone answer is one tap. A
// control row closes the message with Send answers and Answer at console.
//
// Two rules run through everything here. Every string a question contributes is untrusted
// conversation content, so it reaches a label or a description through `inertLabel`, which strips
// the invisible class and bounds the field but escapes no markdown (a component renders plain text,
// so an escape would reach the operator as a visible backslash), and reaches the message text
// through `inertField`, which does escape, because text is markdown. And every `custom_id` is an
// opaque desk reference: an entry id the desk minted plus positions in the ask it holds, never
// content and never a session id, so a forged id names nothing this process will act on and a real
// one resolves entirely server-side.
import {
  inertField,
  inertLabel,
  MAX_MESSAGE_LENGTH,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
} from "./render.ts";
import type { AskedQuestion } from "./render.ts";

/** Discord's ceiling on the action rows one message carries. */
export const MAX_ACTION_ROWS = 5;

/** Discord's ceiling on the buttons one action row carries. */
export const MAX_BUTTONS_PER_ROW = 5;

/**
 * Discord's ceiling on a button's label, twenty units below the one a select option's label takes.
 *
 * A wire requirement rather than a readability choice, and the tighter of the two is the one the
 * fast path spends: a message carrying one field over its limit is refused whole, so a label bounded
 * at the option ceiling and drawn as a button would have the whole upgrade edit rejected, leaving
 * the notice standing over a hold nothing can answer.
 */
export const MAX_BUTTON_LABEL_LENGTH = 80;

/**
 * The most options a single-select question may have and still render as buttons.
 *
 * One row holds five components, and the row is shared with the Answer-at-console button, so four
 * options is what fits. Past it the ask takes the select path, which costs a tap to open the menu.
 */
export const MAX_FAST_PATH_OPTIONS = MAX_BUTTONS_PER_ROW - 1;

/**
 * Room for a question and its header in the message text.
 *
 * Tighter than the notice's own question cap, and it is the whole-message bound rather than a
 * readability choice: four questions at these caps, plus the typed-answer footer both layouts
 * carry, compose to 1,826 UTF-16 units against the 1,900 ceiling, where the notice's 500 would
 * compose past it. The options are not in the text on this path, which is what buys the room back;
 * they are in the select menus, where each carries its description too.
 */
const MAX_PROMPT_QUESTION_LENGTH = 300;
const MAX_PROMPT_HEADER_LENGTH = 100;

/** Separates a question's header from its text, as the card and the notice separate their fields. */
const SEPARATOR = "·";

/**
 * The footer every live question message carries, naming the third way to answer.
 *
 * A message typed in the thread while the ask is held answers the whole ask in the operator's own
 * words, which no component on this message shows: without the line the option exists and nothing
 * says so. It rides both layouts, because the typed path is a property of the hold rather than of
 * how the ask happened to render.
 */
export const TYPED_ANSWER_FOOTER = "_Typing a reply here answers in your own words instead._";

/** The opaque prefix every component this module builds is addressed by. */
const PREFIX = "qd";

/** What a component press means, once its `custom_id` has been resolved against the desk. */
export type ComponentAction =
  | { kind: "answer"; questionIndex: number; optionIndex: number | null }
  | { kind: "send" }
  | { kind: "console" };

/** An entry id and what the pressed component does to it, or null for anything else. */
export type ComponentReference = { entryId: string; action: ComponentAction };

/**
 * Reads a `custom_id` this module wrote.
 *
 * Four shapes, all opaque: `qd:<entry>:<question>` is a select, `qd:<entry>:<question>:<option>` is
 * one option button of the fast path, and `qd:<entry>:send` and `qd:<entry>:console` are the
 * control row. Anything else, including a well-formed id naming an entry the desk no longer holds,
 * reads as null or resolves to nothing: the id is a reference and never evidence, so every value
 * behind it is looked up rather than trusted.
 */
export function parseComponentId(customId: string): ComponentReference | null {
  const parts = customId.split(":");
  if (parts.length < 3 || parts.length > 4 || parts[0] !== PREFIX) return null;
  const entryId = parts[1];
  if (entryId === "") return null;
  if (parts.length === 3 && parts[2] === "send") return { entryId, action: { kind: "send" } };
  if (parts.length === 3 && parts[2] === "console") return { entryId, action: { kind: "console" } };
  const questionIndex = index(parts[2]);
  if (questionIndex === null) return null;
  if (parts.length === 3) {
    return { entryId, action: { kind: "answer", questionIndex, optionIndex: null } };
  }
  const optionIndex = index(parts[3]);
  if (optionIndex === null) return null;
  return { entryId, action: { kind: "answer", questionIndex, optionIndex } };
}

/** A non-negative integer written in the plainest spelling, or null for anything else. */
function index(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * A select's option value: the option's position in the question the desk holds.
 *
 * A position rather than the label itself, and the pair below reads it back. Values are capped at
 * 100 characters on the wire, so a label would have to be cut to fit and a cut label is an answer
 * the picker never offered; a position is bounded by construction and resolves against the entry.
 */
export function optionValue(optionIndex: number): string {
  return String(optionIndex);
}

/** What `optionValue` wrote, or null for a value this module did not write. */
export function parseOptionValue(raw: string): number | null {
  return index(raw);
}

type Button = {
  type: 2;
  style: 1 | 2;
  label: string;
  custom_id: string;
};

type SelectOption = {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
};

type StringSelect = {
  type: 3;
  custom_id: string;
  placeholder: string;
  min_values: number;
  max_values: number;
  options: SelectOption[];
};

export type ActionRow = { type: 1; components: Array<Button | StringSelect> };

/** What the interactive message is: the content Discord renders and the rows under it. */
export type QuestionMessage = { content: string; components: ActionRow[] };

/**
 * Whether this ask can be answered from the thread at all.
 *
 * Four ways it cannot, and the caller's answer to every one of them is today's behavior: the plain
 * notice, and the hold released to the console picker.
 *
 * A question with no readable option has no select to build and no button to press, so it could
 * never be completed here however long it is held. An ask the reader did not carry whole is refused
 * on two separate counts: `questions` is the bounded parse and `questionsInput` is the array the
 * tool wrote, and an answered hold submits a map built over the first while the session reads it
 * against the second, so a question the reader dropped is a question the session gets no answer
 * for, and an option the reader dropped is a choice the console still offers and this thread would
 * not. And two questions asked in the same words share one key in that map, where one answer would
 * silently stand for both.
 */
export function answerableFromThread(
  questions: readonly AskedQuestion[],
  questionsInput: readonly unknown[],
): boolean {
  if (questions.length === 0 || questions.length !== questionsInput.length) return false;
  const asking = new Set<string>();
  for (const [at, asked] of questions.entries()) {
    if (renderableOptions(asked).length === 0) return false;
    if (asking.has(asked.question)) return false;
    asking.add(asked.question);
    if (asked.options.length !== declaredOptions(questionsInput[at])) return false;
  }
  return true;
}

/**
 * How many options the payload's own entry declared, or -1 for an entry that declared nothing this
 * reader could have read: either way a count the bounded parse cannot match by accident.
 */
function declaredOptions(entry: unknown): number {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return -1;
  const options = (entry as Record<string, unknown>)["options"];
  return Array.isArray(options) ? options.length : 0;
}

/**
 * Whether every selection is in and the ask submits without waiting for Send.
 *
 * A single-select question is answered by the tap that chooses its option, so an ask made only of
 * them is complete the moment the last one has a value and the Send button would be a second tap
 * for nothing. A multi-select is not: the operator is still choosing, and submitting on the first
 * choice would answer with one option out of the several they meant.
 */
export function autoSubmits(
  questions: readonly AskedQuestion[],
  selections: ReadonlyArray<readonly string[]>,
): boolean {
  if (questions.some((asked) => asked.multiSelect)) return false;
  return questions.every((_asked, at) => (selections[at] ?? []).length > 0);
}

/** The options that can be drawn: a label neutralizing to nothing is no option at all. */
function renderableOptions(asked: AskedQuestion): Array<{ label: string; at: number }> {
  const drawable: Array<{ label: string; at: number }> = [];
  for (const [at, option] of asked.options.entries()) {
    const label = inertLabel(option.label, MAX_OPTION_LABEL_LENGTH);
    if (label !== "") drawable.push({ label, at });
  }
  return drawable;
}

/** The title line for one question: its number, its header, and the question itself. */
function titleLine(asked: AskedQuestion, number: number | null, multiple: boolean): string {
  const header = asked.header === null ? "" : inertField(asked.header, MAX_PROMPT_HEADER_LENGTH);
  const numbered = number === null ? "" : `${String(number)}.`;
  const bold = [numbered, header].filter((part) => part !== "").join(" ");
  const question = inertField(asked.question, MAX_PROMPT_QUESTION_LENGTH);
  const suffix = multiple ? " *(pick any)*" : "";
  return bold === ""
    ? `**${question}**${suffix}`
    : `**${bold}** ${SEPARATOR} ${question}${suffix}`;
}

/** One question's select menu, with the operator's current choices marked as its defaults. */
function selectRow(
  entryId: string,
  asked: AskedQuestion,
  questionIndex: number,
  chosen: readonly string[],
): ActionRow {
  const drawable = renderableOptions(asked);
  const options: SelectOption[] = drawable.map(({ label, at }) => {
    const description =
      asked.options[at].description === null
        ? null
        : inertLabel(asked.options[at].description, MAX_OPTION_DESCRIPTION_LENGTH);
    return {
      label,
      value: optionValue(at),
      // Left off entirely rather than sent empty: Discord refuses an empty description field, and
      // a description that neutralizes to nothing is a description the call did not carry.
      ...(description === null || description === "" ? {} : { description }),
      // The menu is redrawn from the message on every render, so what the operator already chose is
      // carried as the option's default or it is not shown at all.
      ...(chosen.includes(asked.options[at].label) ? { default: true } : {}),
    };
  });
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `${PREFIX}:${entryId}:${String(questionIndex)}`,
        placeholder: asked.multiSelect ? "Choose any that apply" : "Choose one",
        // Zero, so a choice made by accident can be taken back: at one, a mis-tapped option is one
        // the operator cannot clear, only replace. What a cleared question costs is nothing, because
        // the submit guarantee lives on the desk instead: an ask with a question holding no value
        // submits nothing and names that question.
        min_values: 0,
        max_values: asked.multiSelect ? options.length : 1,
        options,
      },
    ],
  };
}

function button(customId: string, label: string, style: 1 | 2): Button {
  return { type: 2, style, label, custom_id: customId };
}

/**
 * The interactive message for one held ask: the text, and the rows that answer it.
 *
 * The row budget is what shapes this. Discord takes five action rows, `AskUserQuestion` asks at
 * most four questions, and one select each plus the control row is exactly five, so the maximum ask
 * fits without a page. The fast path spends the budget the other way: a single single-select
 * question with at most four options draws them as buttons in one row, with their descriptions in
 * the message text as a numbered list, because the answer is then one tap on a phone rather than a
 * menu to open first.
 *
 * `selections` are the labels the desk has accumulated for each question, which is what makes an
 * edit of this message show the operator their own choices back.
 */
export function renderQuestionPrompt(input: {
  operatorId: string | null;
  entryId: string;
  questions: readonly AskedQuestion[];
  selections: ReadonlyArray<readonly string[]>;
}): QuestionMessage {
  const mention = input.operatorId === null ? "" : `<@${input.operatorId}> `;
  const { entryId, questions } = input;
  const fast =
    questions.length === 1 &&
    !questions[0].multiSelect &&
    renderableOptions(questions[0]).length <= MAX_FAST_PATH_OPTIONS;

  if (fast) {
    const asked = questions[0];
    const drawable = renderableOptions(asked);
    const lines = [
      `${mention}❓ **Waiting on you** ${SEPARATOR} answer here or at the console`,
      "",
      titleLine(asked, null, false),
    ];
    for (const [position, { at }] of drawable.entries()) {
      const description = asked.options[at].description;
      const gloss =
        description === null
          ? ""
          : ` ${SEPARATOR} ${inertField(description, MAX_OPTION_DESCRIPTION_LENGTH)}`;
      const shown = inertField(asked.options[at].label, MAX_OPTION_LABEL_LENGTH);
      lines.push(`${String(position + 1)}. **${shown}**${gloss}`);
    }
    lines.push("", TYPED_ANSWER_FOOTER);
    const row: ActionRow = {
      type: 1,
      components: [
        // Bounded from the raw label again rather than reusing the drawable one: a button's label
        // and a select option's are different Discord fields with different ceilings, and a message
        // carrying one field over its own limit is refused whole.
        ...drawable.map(({ at }) =>
          button(
            `${PREFIX}:${entryId}:0:${String(at)}`,
            inertLabel(asked.options[at].label, MAX_BUTTON_LABEL_LENGTH),
            1,
          ),
        ),
        button(`${PREFIX}:${entryId}:console`, "Answer at console", 2),
      ],
    };
    return { content: lines.join("\n"), components: [row] };
  }

  const count = questions.length;
  const lines = [
    `${mention}❓ **${String(count)} question${count === 1 ? "" : "s"}** ${SEPARATOR} ` +
      "answer here or at the console",
    "",
  ];
  const rows: ActionRow[] = [];
  for (const [at, asked] of questions.entries()) {
    lines.push(titleLine(asked, at + 1, asked.multiSelect));
    rows.push(selectRow(entryId, asked, at, input.selections[at] ?? []));
  }
  lines.push("", TYPED_ANSWER_FOOTER);
  rows.push({
    type: 1,
    components: [
      button(`${PREFIX}:${entryId}:send`, "Send answers", 1),
      button(`${PREFIX}:${entryId}:console`, "Answer at console", 2),
    ],
  });
  return { content: lines.join("\n"), components: rows };
}

/** What an ephemeral nudge says when Send arrives with a question still unanswered. */
export function incompleteNotice(questionNumber: number): string {
  return `Question ${String(questionNumber)} is not answered yet.`;
}

/** What a component press against an entry the desk no longer holds is told. */
export const CLOSED_NOTICE = "That question is no longer open.";

/** What a bound close-out ends with, naming how many answers it had no room to draw. */
function moreAnswersTail(count: number): string {
  return `(+${String(count)} more answered)`;
}

/**
 * The room one question's answer is drawn in.
 *
 * A multi-select answer arrives as one string, its labels joined the way the console's own picker
 * joins them, so what is bounded here is a list rather than a label: every option the ask offered at
 * the per-label ceiling, plus the separators between them. Bounded at one label, three realistic
 * labels would ellipsize. A single-select answer is one label and spends a list's room on it, which
 * costs nothing: the whole message is bound below whatever this leaves.
 */
function answerRoom(asked: AskedQuestion): number {
  const count = Math.max(asked.options.length, 1);
  return count * MAX_OPTION_LABEL_LENGTH + (count - 1) * ", ".length;
}

/**
 * The message a resolved hold is edited to, one line per terminal state.
 *
 * Every state edits and every edit strips the components, because a message whose buttons answer a
 * hold that has ended is a tap that reports a failure to the operator and changes nothing. The four
 * release states say the same thing in their own words, since what the operator does next is the
 * same in all of them: the console picker is up. The two answered states carry no such instruction,
 * because nothing is left to do: the thread's own answer renders what was submitted, so the thread
 * carries the answer rather than only the fact of one, and the console's answer closes the message
 * a release state left pointing at a picker that has since been answered.
 */
export function renderQuestionOutcome(input: {
  state: "answered" | "answered-at-console" | "released" | "expired" | "client-gone" | "shutdown";
  questions: readonly AskedQuestion[];
  answers: Readonly<Record<string, string | readonly string[]>> | null;
  response: string | null;
}): string {
  if (input.state === "answered-at-console") {
    // What was answered rides along without what it was answered with: the console's picks reach
    // this broker nowhere, and the transcript line that reports the answer carries only the ask.
    return [
      "✅ **Answered at the console**",
      ...input.questions.map((asked, at) =>
        titleLine(asked, input.questions.length === 1 ? null : at + 1, false),
      ),
    ].join("\n");
  }
  if (input.state !== "answered") {
    const reason = {
      released: "released to the console",
      expired: "the hold expired",
      "client-gone": "the session stopped waiting",
      shutdown: "the broker restarted",
    }[input.state];
    // The titles ride along, because this edit replaces the only copy of the question the thread
    // has: a bare closing line would leave the operator walking to a console without knowing what
    // is waiting there.
    return [
      `❓ **Question closed** ${SEPARATOR} ${reason}, answer it at the console`,
      ...input.questions.map((asked, at) =>
        titleLine(asked, input.questions.length === 1 ? null : at + 1, false),
      ),
    ].join("\n");
  }
  const lines = ["✅ **Answered from the thread**"];
  if (input.response !== null) {
    lines.push(inertField(input.response, MAX_PROMPT_QUESTION_LENGTH));
    return lines.join("\n");
  }
  let used = lines[0].length;
  for (const [at, asked] of input.questions.entries()) {
    // Read as an own property, never through the prototype: question text is untrusted
    // conversation content and this map is keyed by it, so a question asked as `__proto__` names a
    // key every plain object already answers with an object where a label belongs.
    const answers = input.answers;
    if (answers === null || !Object.hasOwn(answers, asked.question)) continue;
    const given = answers[asked.question];
    const shown =
      typeof given === "string"
        ? inertField(given, answerRoom(asked))
        : given
            .map((label) => inertField(label, MAX_OPTION_LABEL_LENGTH))
            .filter((label) => label !== "")
            .join(", ");
    const header =
      asked.header === null
        ? inertField(asked.question, MAX_PROMPT_HEADER_LENGTH)
        : inertField(asked.header, MAX_PROMPT_HEADER_LENGTH);
    const line = `**${header}** ${SEPARATOR} ${shown}`;
    // The whole message is bound here, `renderQuestionNotice`'s pattern: the answers go on whole,
    // and the first that would not leave room for the tail ends the message with a count of the
    // rest. This edit goes straight to Discord rather than through the writer's own cut, and a
    // message over the limit is refused whole, which would leave the components live on a hold that
    // has already ended.
    const remaining = input.questions.length - at;
    if (used + 1 + line.length + 1 + moreAnswersTail(remaining).length > MAX_MESSAGE_LENGTH) {
      lines.push(moreAnswersTail(remaining));
      return lines.join("\n");
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join("\n");
}
