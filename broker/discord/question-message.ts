// The interactive question message: what a question the desk is holding looks like in the thread,
// and how a tap on it comes back.
//
// One message per ask, and the split through it is reading against answering. The text is the
// reading copy: the mention, a title line per question, and that question's options numbered under
// it with the gloss the call wrote for each. The components are the picker: a string select per
// question, or, for the single-question ask small enough to fit one row, the options themselves as
// buttons so the phone answer is one tap. A control row closes the message with Send answers and
// Answer at console.
//
// The split is what keeps the ask readable. Discord caps a select option's label and description at
// a hundred units each and a button's label at eighty, refuses a message whole for one field over,
// and ellipsizes what survives to the width of a menu opened on a phone. None of that reaches the
// text, which wraps to the reader's own window, so the options are drawn there whole and the
// components are left to do nothing but carry the tap.
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
 * Room for a question, its header, and one option's gloss in the message text.
 *
 * The body is the reading surface and the components are the picker, which is what sets these. A
 * select option's own fields stop at Discord's ceilings, narrow enough that a real description
 * arrives cut and a phone ellipsizes what survives inside the open menu, and there is nothing this
 * renderer can do about either. The body has no such ceiling and wraps to the reader's own window,
 * so it is where an option is actually read, and these caps are set from the measured shape of real
 * `AskUserQuestion` calls rather than from any wire limit: questions and descriptions both run to
 * about 400 code points at the ninetieth percentile, and both caps clear that.
 *
 * They do not hold the message inside one Discord message on their own, and are not asked to. The
 * per-question budget below owns that, and it is what lets these be generous.
 */
const MAX_PROMPT_QUESTION_LENGTH = 500;
const MAX_PROMPT_HEADER_LENGTH = 100;
const MAX_BODY_DESCRIPTION_LENGTH = 400;

/**
 * What the head and the footer are allowed to cost, so the questions can be given the rest.
 *
 * Reserved rather than measured, because the budget has to be known before the head is composed:
 * the mention is at most a couple of dozen units and the headline a couple of dozen more, and the
 * footer is a fixed string. Both together sit inside this with room to spare, and the spare is the
 * slack that keeps the assembled message under the ceiling whatever rounding the split leaves.
 */
const PROMPT_FURNITURE_ROOM = 200;

/**
 * The room every question's block is allowed, given what each of them wants and the room they share.
 *
 * The notice's rule is first-come, and this message cannot take it: the notice sends the operator to
 * a console that holds the whole question, where a question past the cut loses nothing that matters,
 * while this is the message being answered, and a question drawn nowhere in the body is one whose
 * options would be picked unread. So every question is guaranteed a share.
 *
 * An equal share is the obvious way to guarantee one and it is the wrong one, because what a
 * question wants varies by more than the count does: measured against the real asks this host has
 * held, an equal share spilled options out of four asks whose whole message still had hundreds of
 * units unspent, one of them at 1,005 units against a 1,900 ceiling. What was missing was not room,
 * it was the room a two-option question did not want going to the four-option question beside it.
 *
 * So this is `columnCaps`'s rule, which the fenced-table renderer already shares a width by: find the
 * highest ceiling the budget can carry, let every question under it have exactly what it asked for,
 * and hold the rest to it. A question spills only when its own need is past a ceiling that the whole
 * message could not raise, which is the only honest reason to spill.
 */
function questionRooms(needs: readonly number[], budget: number): number[] {
  const spent = (limit: number): number =>
    needs.reduce((total, need) => total + Math.min(need, limit), 0);
  let cap = Math.max(...needs, MIN_QUESTION_ROOM);
  while (cap > MIN_QUESTION_ROOM && spent(cap) > budget) cap -= 1;
  return needs.map((need) => Math.min(need, cap));
}

/**
 * The floor a share never goes below, whatever the questions want.
 *
 * Set above what a question's own furniture costs at the title floor: a number, a header at its cap,
 * the separators between them, a question at `titleRoom`'s floor, the multi-select suffix, and the
 * marker line, which is about 256 units in the worst case. Below that a block could compose past the
 * share it was given, and the guarantee this whole split rests on is that it never does. Four floors
 * sit well inside the budget, so the floor can never be the thing that overruns the message.
 */
const MIN_QUESTION_ROOM = 280;

/** What a question's drawn block costs, in the units its share is measured in. */
function blockCost(lines: readonly string[]): number {
  const [title, ...rest] = lines;
  return (title?.length ?? 0) + rest.reduce((total, line) => total + 1 + line.length, 0);
}

/**
 * Room added to what a question wants, so that a share equal to its want really draws it whole.
 *
 * The option loop keeps back room for the marker an undrawn option would need, and it decides that
 * one option at a time, before it knows whether the ones after it will fit. A share measured from a
 * block that needed no marker would therefore be a share the loop spends a marker's width of and
 * then falls short by, spilling the last option of a question the message had exactly enough room
 * for. This is that width: the widest marker either layout writes, and the newline before it.
 */
const MARKER_ROOM = 60;

/**
 * A room no block reaches, for measuring what a question would draw if nothing held it back. The
 * need it yields is what `questionRooms` shares the message out against.
 */
const UNBOUNDED_ROOM = Number.MAX_SAFE_INTEGER;

/**
 * The room a question's own text gets inside its share, so a long question cannot spend the share
 * its options are drawn in. The floor is what keeps a four-question ask from drawing a question
 * cut to nothing; the cap is the readability bound above, which binds whenever the share is roomy.
 */
function titleRoom(room: number): number {
  return Math.max(Math.min(MAX_PROMPT_QUESTION_LENGTH, room - 250), 80);
}

/**
 * The room a question's text gets on a terminal-state message, which carries titles and nothing
 * else.
 *
 * Its own budget rather than the readability cap, because these messages enforce no bound of their
 * own and nothing downstream fails loudly for them: the writer neutralizes through `inertMessage`,
 * which cuts to the ceiling rather than refusing, so a message composed past it posts with its tail
 * eaten and no marker saying so. That tail is the later questions, on the one message whose job is
 * telling the operator what is waiting at a console. Four questions at the readability cap compose
 * past 2,400 units against a 1,900 ceiling; at this budget they compose inside it, since a title is
 * about 110 units of number, header, and separators around the question itself.
 */
function outcomeTitleRoom(count: number): number {
  const share = Math.floor((MAX_MESSAGE_LENGTH - PROMPT_FURNITURE_ROOM) / Math.max(count, 1));
  return Math.max(Math.min(MAX_PROMPT_QUESTION_LENGTH, share - 110), 80);
}

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
  /** The three Discord styles the rows in this broker draw: primary, secondary, and danger. */
  style: 1 | 2 | 4;
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

/**
 * The title line for one question: its number, its header, and the question itself.
 *
 * `room` is what the question text is held to, which the prompt narrows as an ask grows and the
 * terminal states leave at the readability cap: those messages carry no options, so nothing there
 * is competing with the question for the line.
 */
function titleLine(
  asked: AskedQuestion,
  number: number | null,
  multiple: boolean,
  room: number = MAX_PROMPT_QUESTION_LENGTH,
): string {
  const header = asked.header === null ? "" : inertField(asked.header, MAX_PROMPT_HEADER_LENGTH);
  const numbered = number === null ? "" : `${String(number)}.`;
  const bold = [numbered, header].filter((part) => part !== "").join(" ");
  const question = inertField(asked.question, room);
  const suffix = multiple ? " *(pick any)*" : "";
  return bold === ""
    ? `**${question}**${suffix}`
    : `**${bold}** ${SEPARATOR} ${question}${suffix}`;
}

/**
 * What a question's block ends with when its share had no room for the rest of its options.
 *
 * Worded by layout, because the two layouts withhold different things. A menu holds the options
 * themselves, so a marker there names where to find them. A button row already shows every option,
 * so what did not fit is the gloss beside it and nothing else, and a marker sending the operator to
 * a menu would name a component this message does not have.
 */
function moreOptionsTail(count: number, fast: boolean): string {
  return fast
    ? `_(+${String(count)} more on the buttons below, without their notes)_`
    : `_(+${String(count)} more in the menu below)_`;
}

/**
 * One option as the body draws it: its position, its label, and whatever gloss the call wrote.
 *
 * The gloss is the reason this rendering exists. A description is where an option says what
 * choosing it costs, so it is the field the operator actually decides on, and the select menu it
 * otherwise lives in shows it cut to a hundred units and ellipsized to the width of an open menu on
 * a phone. Here it wraps to the reader's own window, at a cap set from what real calls carry.
 */
function optionLine(asked: AskedQuestion, at: number, position: number): string {
  const description = asked.options[at].description;
  const gloss =
    description === null
      ? ""
      : ` ${SEPARATOR} ${inertField(description, MAX_BODY_DESCRIPTION_LENGTH)}`;
  const shown = inertField(asked.options[at].label, MAX_OPTION_LABEL_LENGTH);
  return `${String(position + 1)}. **${shown}**${gloss}`;
}

/**
 * The lines one question contributes to the body: its title, then its options under it, as many as
 * its share holds whole.
 *
 * One helper for both layouts, so an option cannot read one way where it is drawn as a button and
 * another way where it is drawn in a menu. Options go on whole and the first that would not leave
 * room for the marker ends the block, `renderQuestionNotice`'s rule: an option half-drawn is a
 * choice described by the front of a sentence, which is worse than one the marker sends to the menu
 * honestly. Every option is in the components either way; this is the reading copy, not the picker.
 */
function questionLines(
  asked: AskedQuestion,
  number: number | null,
  room: number,
  fast: boolean,
): string[] {
  const title = titleLine(asked, number, asked.multiSelect, titleRoom(room));
  const lines = [title];
  let used = title.length;
  const drawable = renderableOptions(asked);
  for (const [position, { at }] of drawable.entries()) {
    const line = optionLine(asked, at, position);
    // Room kept back for the marker this option's own drawing would make necessary, which is none
    // where it is the last: a marker after the final option would name nothing left to name, and
    // reserving for one would spill an option whose only problem was a line that does not exist.
    const left = drawable.length - position - 1;
    const reserve = left === 0 ? 0 : 1 + moreOptionsTail(left, fast).length;
    if (used + 1 + line.length + reserve > room) {
      lines.push(moreOptionsTail(drawable.length - position, fast));
      return lines;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return lines;
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
 * The row budget is what shapes the components. Discord takes five action rows, `AskUserQuestion`
 * asks at most four questions, and one select each plus the control row is exactly five, so the
 * maximum ask fits without a page. The fast path spends the budget the other way: a single
 * single-select question with at most four options draws them as buttons in one row, because the
 * answer is then one tap on a phone rather than a menu to open first.
 *
 * The body is the same on both paths and does not depend on that choice: every question draws its
 * own title and its own options, because what the operator reads to decide is the ask, not the
 * widget the ask happens to have been given. Every question gets the share `questionRooms` allows
 * it, which is everything it wants wherever the message can carry that, and inside its share the
 * options go on whole until the share runs out. So what is drawn is complete, what did not fit is
 * named and still answerable in the components, and a question spills only where the message really
 * had no room for it rather than because a neighbour was holding room it never wanted.
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
  const { entryId } = input;
  // Bounded here rather than trusted from the caller, so both budgets this function holds are
  // arithmetic over a number it knows. The reader slices an ask to four questions and Discord takes
  // five action rows, one select each plus the control row, so four is the same number twice and
  // neither bound is this function's to discover by being handed a fifth: a longer ask would draw
  // rows Discord refuses the message for, and shares that sum past the message ceiling.
  const questions = input.questions.slice(0, MAX_ACTION_ROWS - 1);
  const fast =
    questions.length === 1 &&
    !questions[0].multiSelect &&
    renderableOptions(questions[0]).length <= MAX_FAST_PATH_OPTIONS;

  const count = questions.length;
  const rows: ActionRow[] = [];
  if (fast) {
    rows.push({
      type: 1,
      components: [
        // Bounded from the raw label again rather than reusing the drawable one: a button's label
        // and a select option's are different Discord fields with different ceilings, and a message
        // carrying one field over its own limit is refused whole.
        ...renderableOptions(questions[0]).map(({ at }) =>
          button(
            `${PREFIX}:${entryId}:0:${String(at)}`,
            inertLabel(questions[0].options[at].label, MAX_BUTTON_LABEL_LENGTH),
            1,
          ),
        ),
        button(`${PREFIX}:${entryId}:console`, "Answer at console", 2),
      ],
    });
  } else {
    for (const [at, asked] of questions.entries()) {
      rows.push(selectRow(entryId, asked, at, input.selections[at] ?? []));
    }
    rows.push({
      type: 1,
      components: [
        button(`${PREFIX}:${entryId}:send`, "Send answers", 1),
        button(`${PREFIX}:${entryId}:console`, "Answer at console", 2),
      ],
    });
  }

  // One body for both layouts. What differs between them is which components answer the ask, not
  // what the operator reads to decide, and the reading copy used to exist only on the button path:
  // an ask that took a menu carried its options nowhere but inside the menus, where Discord caps
  // each field at a hundred units and a phone ellipsizes what is left. Drawing them here is what
  // makes a menu a picker rather than the only place the ask can be read.
  const headline = fast
    ? "**Waiting on you**"
    : `**${String(count)} question${count === 1 ? "" : "s"}**`;
  const lines = [`${mention}❓ ${headline} ${SEPARATOR} answer here or at the console`];
  const numbered = (at: number): number | null => (count === 1 ? null : at + 1);
  // What each question would draw unheld, then the shares that fit those wants inside one message.
  // Measured before anything is drawn, because a share cannot be decided from a question in
  // isolation: what one does not want is what another gets.
  const budget = MAX_MESSAGE_LENGTH - PROMPT_FURNITURE_ROOM;
  const rooms = questionRooms(
    questions.map(
      (asked, at) =>
        blockCost(questionLines(asked, numbered(at), UNBOUNDED_ROOM, fast)) + MARKER_ROOM,
    ),
    budget,
  );
  const blocks = questions.map((asked, at) =>
    questionLines(asked, numbered(at), rooms[at] ?? MIN_QUESTION_ROOM, fast),
  );

  // One refinement round, because a share is only spendable in whole options. A block stops at the
  // last option that fits and leaves the rest of its share unspent, and that remainder is room the
  // next option of some other question would have fit in: measured over the real asks this host has
  // held, a four-question ask spilled at 1,005 units of a 1,900 message with the rest of its budget
  // stranded that way. So what the blocks did not use goes back to the ones that ran short.
  //
  // Each is regrown from what it actually spent rather than from what it was allowed, which is what
  // makes the total provably no larger than the budget: the sum of what was spent plus the whole of
  // what was not is the budget itself. One round rather than a loop, since a second recovers only
  // the remainder of a remainder, and a fixed round needs no argument that it terminates.
  let spare = budget - blocks.reduce((total, block) => total + blockCost(block), 0);
  for (const [at, block] of blocks.entries()) {
    if (spare <= 0) break;
    if (block.length - 1 >= renderableOptions(questions[at]).length) continue;
    // The whole remainder is offered rather than a share of it, and what this block does not take
    // passes to the next that ran short. An even split is what fails here: an option line runs to
    // several hundred units, so a quarter of the remainder is usually too little to fit one more of
    // anything, and four questions each holding a quarter draw exactly what they drew before.
    const grown = questionLines(questions[at], numbered(at), blockCost(block) + spare, fast);
    spare -= blockCost(grown) - blockCost(block);
    blocks[at] = grown;
  }
  for (const block of blocks) lines.push("", ...block);
  lines.push("", TYPED_ANSWER_FOOTER);
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
        titleLine(
          asked,
          input.questions.length === 1 ? null : at + 1,
          false,
          outcomeTitleRoom(input.questions.length),
        ),
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
        titleLine(
          asked,
          input.questions.length === 1 ? null : at + 1,
          false,
          outcomeTitleRoom(input.questions.length),
        ),
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
