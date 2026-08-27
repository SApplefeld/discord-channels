// This repo runs TypeScript directly under Node's type stripping, with no build step and no
// emit. That makes the conventional dot-js relative specifier fatal at runtime
// (ERR_MODULE_NOT_FOUND, because no .js file is ever produced) while `tsc --noEmit` reports it
// clean: under moduleResolution nodenext the specifier resolves to the .ts file at type-check
// time. An extensionless relative specifier fails the same way. No compiler option catches
// either, so this test is the enforcement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";

// The specifier of a static from-clause, which lands on the closing line of even a multi-line
// import, and of a dynamic import call.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const WHOLE_LINE_COMMENT = /^\s*\/\/.*$/gm;

const SOURCES = globSync("**/*.{ts,mts,cts}", {
  exclude: (path) => path.includes("node_modules") || path.startsWith("dist"),
});

// Prose describing this rule necessarily contains the shapes the rule forbids. Only whole-line
// comments are dropped, never a trailing one, so a mid-line "//" inside a URL cannot swallow a
// real import sharing its line.
function code(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(WHOLE_LINE_COMMENT, "");
}

test("every relative import carries an explicit TypeScript extension", () => {
  const offenders: string[] = [];

  for (const file of SOURCES) {
    for (const [, specifier] of code(readFileSync(file, "utf8")).matchAll(SPECIFIER)) {
      // Bare specifiers (node:test, discord.js) are resolved by Node and are not our business.
      if (!specifier.startsWith(".")) continue;
      if (/\.(ts|mts|cts)$/.test(specifier)) continue;
      offenders.push(`${file}: ${specifier}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Relative imports must end in .ts, .mts, or .cts. There is no build step, so any other form ` +
      `type-checks clean and throws at runtime:\n  ${offenders.join("\n  ")}`,
  );
});

/**
 * The specifiers a file imports at run time: a from-clause whose `import` is not a type-only one,
 * and a bare side-effect import, which is a runtime edge carrying no binding.
 *
 * A type-only import is erased before anything executes, so it builds no edge in the module graph
 * and cannot participate in a cycle. The lookahead is what tells the two apart, and it is anchored
 * on the `import` keyword rather than searched, so a runtime import earlier in the file cannot lend
 * its match to a type-only one below it.
 */
const RUNTIME_FROM = /\bimport\s+(?!type\b)[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const RUNTIME_BARE = /\bimport\s*["']([^"']+)["']/g;

function runtimeImports(source: string): string[] {
  const stripped = code(source);
  return [
    ...[...stripped.matchAll(RUNTIME_FROM)].map((match) => match[1]),
    ...[...stripped.matchAll(RUNTIME_BARE)].map((match) => match[1]),
  ];
}

test("the tailer answers the routing layer's runtime import with no runtime import back", () => {
  // The one layer edge in this repo that runs in both directions, and the only thing keeping it
  // acyclic is that one side is type-only. The peer classification lives in the tailer and the
  // routing layer calls it, while the tailer names the router's `ReplyResult` for its delivery
  // seams. Erased at run time that is one edge; converted to a value import it is a cycle, and a
  // cycle here does not fail the type check and does not fail at import: it leaves whichever module
  // Node evaluates second holding an undefined binding, which throws at the first call, on a path
  // that only a live peer message reaches.
  const outbound = readFileSync("broker/routing/outbound.ts", "utf8");
  const tail = readFileSync("broker/tail.ts", "utf8");

  // The control. Without the runtime edge this pin is about, the assertion below is a check nobody
  // could fail, and it would stay green through the refactor that removed the reason for it.
  assert.ok(
    runtimeImports(outbound).includes("../tail.ts"),
    "the routing layer is expected to import the tailer at run time; if that ended, this pin has " +
      "no subject and should be reconsidered rather than left passing",
  );
  assert.ok(
    code(tail).includes('from "./routing/outbound.ts"'),
    "the tailer is expected to name the router's result type; if that ended, likewise",
  );

  assert.deepEqual(
    runtimeImports(tail).filter((specifier) => specifier.includes("routing/")),
    [],
    "broker/tail.ts must reach the routing layer by type-only imports alone: a runtime import back " +
      "closes a cycle that type-checks clean and throws only when a peer message arrives",
  );
});

test("the two restore paths reach the title normalization without importing the render layer", () => {
  // `persistence.ts` reads the registry snapshot and `discord/bindings.ts` reads the thread
  // bindings, and both re-admit a session title from a file anything running as this user can
  // rewrite. They need the whole `boundedTitle` composition to do it, and taking that from
  // `discord/render.ts` would put a module that itself imports `registry.ts` and `board/events.ts`
  // on the load path a state file is read through: one edge from `render.ts` back to either of
  // these files closes a cycle that type-checks clean and throws only at the first restore, taking
  // every binding with it. The composition lives in `sanitize.ts`, which imports nothing, so the
  // direction is closed rather than merely unused today.
  const persistence = readFileSync("broker/persistence.ts", "utf8");
  const bindings = readFileSync("broker/discord/bindings.ts", "utf8");

  // The control. If the composition moved back into the render layer, or these files stopped
  // needing it, the assertion below would be a check nobody could fail.
  for (const [name, source] of [
    ["broker/persistence.ts", persistence],
    ["broker/discord/bindings.ts", bindings],
  ] as const) {
    assert.ok(
      /boundedTitle/.test(code(source)),
      `${name} is expected to normalize a restored title through boundedTitle; if that ended, this ` +
        "pin has no subject and should be reconsidered rather than left passing",
    );
  }

  for (const [name, source] of [
    ["broker/persistence.ts", persistence],
    ["broker/discord/bindings.ts", bindings],
  ] as const) {
    assert.deepEqual(
      runtimeImports(source).filter((specifier) => /render\.ts$/.test(specifier)),
      [],
      `${name} must not import the render layer at run time: it is read on the state-file and ` +
        "bindings load path, and the render layer reaches the registry and the board events from there",
    );
  }
});

test("the normalization module is a leaf, so every layer may reach it", () => {
  // `sanitize.ts` is imported by the storage layer, the renderer and the registry alike, and the
  // registry is itself imported by the renderer. That fan-in is safe only while this module sits at
  // the bottom of the graph: one runtime import out of it, into any module that can reach back,
  // closes a cycle that type-checks clean and throws at the first call rather than at import. The
  // module says as much in its own header; this is what makes the claim enforced rather than
  // asserted.
  const sanitize = readFileSync("broker/sanitize.ts", "utf8");

  // The control. If nothing reached this module any more, the assertion below would be a check
  // nobody could fail.
  assert.ok(
    runtimeImports(readFileSync("broker/registry.ts", "utf8")).includes("./sanitize.ts"),
    "the registry is expected to import the normalization module at run time; if that ended, this " +
      "pin has no subject and should be reconsidered rather than left passing",
  );

  assert.deepEqual(
    runtimeImports(sanitize),
    [],
    "broker/sanitize.ts must import nothing at run time: every layer reaches it, so an import out " +
      "of it is the one edge that can close a cycle through the registry or the renderer",
  );
});

test("the scan actually reaches this repo's sources", () => {
  // Without this, a glob that silently matched nothing would make the check above vacuously pass.
  assert.ok(SOURCES.includes("import-hygiene.test.ts"), `scanned files: ${SOURCES.join(", ")}`);
});
