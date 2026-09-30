// Scores the response gate's shadow journal against hand-written labels, so the threshold the
// gate delivers at is a measured value before the mode flips to live.
//
//   node tools/response-gate-score.ts <journal> <labels>
//
// The journal is `response-gate.jsonl` from the broker's state directory, one JSON row per gate
// decision. The labels file holds one `<id>\t<yes|no>` line per row the operator judged, keyed by
// the row's `id`, the Discord id of the newest buffered message: yes where that message expected a
// response from the assistant, no where it did not. For each threshold from 0.40 to 0.95 in steps
// of 0.05 the table prints the precision and recall of "probability >= threshold" over the
// labelled rows. Rows with no probability (the certain triggers and the age cap) are skipped, a
// row's last appearance wins where an id was judged more than once, and a labelled id with no
// judged row counts nowhere.
import { readFileSync } from "node:fs";
import { runDirectly } from "../broker/entrypoint.ts";

/** One judged row: the id a label names and the probability the judge returned for it. */
export type ScoredRow = { id: string; probability: number };

/** The thresholds, in hundredths so the steps land exactly and 0.95 is never skipped by drift. */
export const THRESHOLDS: readonly number[] = Array.from({ length: 12 }, (_, index) => 40 + index * 5);

/**
 * The judged rows of a journal, last row per id. A line that is not JSON, not an object, or has
 * no finite probability is skipped: a certain-trigger row has none by design, and a torn line
 * from a rotation is not worth stopping over.
 */
export function readJournal(text: string): Map<string, number> {
  const rows = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { id, probability } = parsed as { id?: unknown; probability?: unknown };
    if (typeof id !== "string" || typeof probability !== "number" || !Number.isFinite(probability)) continue;
    rows.set(id, probability);
  }
  return rows;
}

/**
 * The labels, `<id>\t<yes|no>` per line, blank lines skipped. Any other line is refused with its
 * number, since a label file is short and hand-written and a silently dropped line is a score
 * that reads as measured while missing a case.
 */
export function readLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const match = /^(\S+)\t(yes|no)$/i.exec(trimmed);
    if (match === null) {
      throw new Error(`labels line ${String(index + 1)} is not <id><tab><yes|no>`);
    }
    labels.set(match[1], match[2].toLowerCase() === "yes");
  });
  return labels;
}

/** Precision and recall at one threshold, or null where the ratio has no denominator. */
export type Score = { threshold: number; precision: number | null; recall: number | null };

/** The table: one score per threshold, over the labelled rows the journal judged. */
export function score(journal: Map<string, number>, labels: Map<string, boolean>): Score[] {
  const cases: Array<{ probability: number; yes: boolean }> = [];
  for (const [id, yes] of labels) {
    const probability = journal.get(id);
    if (probability !== undefined) cases.push({ probability, yes });
  }
  const positives = cases.filter((c) => c.yes).length;
  return THRESHOLDS.map((hundredths) => {
    const threshold = hundredths / 100;
    const predicted = cases.filter((c) => c.probability >= threshold);
    const hits = predicted.filter((c) => c.yes).length;
    return {
      threshold,
      precision: predicted.length === 0 ? null : hits / predicted.length,
      recall: positives === 0 ? null : hits / positives,
    };
  });
}

function cell(value: number | null): string {
  return value === null ? "n/a  " : value.toFixed(3);
}

/** The printed table, with the case count on top so an empty overlap reads as one. */
export function render(journal: Map<string, number>, labels: Map<string, boolean>): string {
  let labelled = 0;
  let yes = 0;
  for (const [id, label] of labels) {
    if (!journal.has(id)) continue;
    labelled += 1;
    if (label) yes += 1;
  }
  const lines = [
    `labelled judged rows: ${String(labelled)} (yes ${String(yes)}, no ${String(labelled - yes)})`,
    "threshold  precision  recall",
  ];
  for (const row of score(journal, labels)) {
    lines.push(`${row.threshold.toFixed(2)}       ${cell(row.precision)}      ${cell(row.recall)}`);
  }
  return `${lines.join("\n")}\n`;
}

if (runDirectly(import.meta.url)) {
  const [journalPath, labelsPath] = process.argv.slice(2);
  if (journalPath === undefined || labelsPath === undefined) {
    console.error("usage: node tools/response-gate-score.ts <journal> <labels>");
    process.exit(2);
  }
  process.stdout.write(
    render(readJournal(readFileSync(journalPath, "utf8")), readLabels(readFileSync(labelsPath, "utf8"))),
  );
}
