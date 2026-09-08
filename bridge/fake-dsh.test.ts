// The stand-in's own two seams, which every test in `harness.test.ts` rests on without being able
// to see them.
//
// A stand-in that misreads its own arguments or dies on a frame reports a bridge defect that is not
// there: the suite goes red, the failure names the bridge, and the bug is in the double. Both seams
// fail exactly that way, which is why they are pinned here rather than left to the runs that use
// them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { option, readFrame } from "./fake-dsh.ts";

test("a flag with no value of its own does not take the next flag as one", () => {
  // `--reason --own-idle` is the shape: a caller meaning two flags writes one flag and one value,
  // and the replay then ends every turn with a reason named `--own-idle` while the idle it asked
  // for never arrives. The test it breaks is about turn kinds, so the failure reads as the bridge
  // getting the kind wrong.
  assert.equal(option(["node", "fake", "--reason", "--own-idle"], "reason"), undefined);
  assert.equal(option(["node", "fake", "--reason"], "reason"), undefined, "a flag at the end names no value either");

  // The control: an ordinary value is still read, so the two above are the guard rather than an
  // option reader that has stopped reading options.
  assert.equal(option(["node", "fake", "--reason", "blocked"], "reason"), "blocked");
  assert.equal(option(["node", "fake"], "reason"), undefined, "and an absent flag is still absent");
});

test("a line that is not a frame is skipped rather than taking the runtime down", () => {
  // Stdin is the transport and a runtime that dies on one unreadable line dies in the middle of a
  // turn, which reaches the bridge as a lost stream and reaches the suite as a bridge that lost a
  // worker it never lost.
  assert.equal(readFrame("{not json"), undefined);
  assert.equal(readFrame(""), undefined);

  // The control: a real frame is read, so the refusals above are the guard rather than a reader
  // that has stopped reading.
  assert.deepEqual(readFrame('{"jsonrpc":"2.0","id":"7","method":"initialize"}'), {
    jsonrpc: "2.0",
    id: "7",
    method: "initialize",
  });
});
