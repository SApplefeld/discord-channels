// What the DSH runtime child is handed, which is a guard rather than a convenience: the child is a
// coding agent running unsandboxed as this user, and the environment it starts from is everything
// this Claude session happens to be carrying.
//
// Nothing here spawns anything. `childEnv` builds its base from `scrubbedParentEnv`, which reads
// this process's own environment, so the seeding below is done on `process.env` and taken back off
// it in the same test. Each absence is asserted beside a name shaped almost like it that survives,
// because an environment builder that returned nothing at all would pass every absence on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv, requireRuntimeBin } from "./env.ts";

/** What the seeded environment carries, and what each name is here to prove. */
const SEEDED = {
  // This session's own names, which name its messaging socket and its identity.
  CLAUDE_CODE_SSE_PORT: "41234",
  CLAUDECODE: "1",
  CHANNEL_PROCESS_TOKEN: "a-token",
  // The controls: one character away from the two families above and not in either of them.
  CLAUDIUS_KEEPS: "kept",
  CHANNELING_KEEPS: "kept",
  // The vendor scrub's own two shapes: a credential-shaped name and a `DSH_` name.
  BRIDGE_TEST_SECRET_TOKEN: "sensitive",
  DSH_SOMETHING_ELSE: "vendor-scrubbed",
  DSH_HOME: "a-home-this-function-replaces",
  // An ordinary name, which is the whole reason the parent environment is copied at all.
  BRIDGE_TEST_ORDINARY: "kept",
};

/** Seed the environment for one test and take it back off afterwards. */
function seed(t: { after: (fn: () => void) => void }): void {
  const before = new Map(Object.entries(SEEDED).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(SEEDED)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("the session's own names are dropped, the vendor scrub is kept, and the home is set after it", (t) => {
  seed(t);

  const env = childEnv("D:\\a-home", undefined);

  assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined, "a Claude session's socket is not the worker's to hold");
  assert.equal(env.CLAUDECODE, undefined, "the family is matched by prefix, not by an exact name");
  assert.equal(env.CHANNEL_PROCESS_TOKEN, undefined, "nor is the token that identifies this session to the broker");
  assert.equal(env.BRIDGE_TEST_SECRET_TOKEN, undefined, "the vendor scrub's credential shapes are gone too");
  assert.equal(env.DSH_SOMETHING_ELSE, undefined, "and its DSH_ names, which is why the home is set after it");

  // The controls. Each is one character away from a name that was dropped, so a green above is
  // these two families and not an environment that arrived empty.
  assert.equal(env.CLAUDIUS_KEEPS, "kept", "CLAUDE is the prefix, and CLAUDIUS is not in it");
  assert.equal(env.CHANNELING_KEEPS, "kept", "CHANNEL_ carries its underscore, and CHANNELING does not match it");
  assert.equal(env.BRIDGE_TEST_ORDINARY, "kept", "an ordinary name is what the child needs and is passed through");

  // The home is this function's own act, laid over a scrub that had just removed the name.
  assert.equal(env.DSH_HOME, "D:\\a-home");
});

test("the provider key reaches the child only when the parent carries one", (t) => {
  // It is named by the provider entry in the operator's settings and it is credential-shaped, so
  // the vendor scrub takes it and passing it back is a deliberate act. A key invented where the
  // parent has none would be a value the runtime then sends to the model host.
  seed(t);

  assert.equal(childEnv("D:\\a-home", undefined).OLLAMA_API_KEY, undefined);
  assert.equal(childEnv("D:\\a-home", "").OLLAMA_API_KEY, "", "an empty value is a value the parent carried");
  assert.equal(childEnv("D:\\a-home", "k").OLLAMA_API_KEY, "k");
});

test("a missing runtime install is a refusal naming the install command", (t) => {
  // The bridge reads this at its first spawn and hands the sentence to the model as a failed tool
  // call. It is the only place the command that fixes it is ever said.
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => requireRuntimeBin(path.join(dir, "nowhere", "bin.js")),
    (error: Error) => /npm ci/.test(error.message) && error.message.includes("bridge/runtime"),
    "the refusal names what to run and where",
  );

  // The control: an installed launcher this test made itself, so the throw above is a missing file
  // rather than a check that always throws. Its own file rather than the checkout's real launcher,
  // which is produced by a second `npm ci` inside `bridge/runtime` and is absent from a fresh
  // clone: a test asserting on it would be red for a reason that is not the code.
  const installed = path.join(dir, "bin.js");
  writeFileSync(installed, "");
  assert.equal(requireRuntimeBin(installed), installed);
});
