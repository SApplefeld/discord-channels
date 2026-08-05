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

test("the scan actually reaches this repo's sources", () => {
  // Without this, a glob that silently matched nothing would make the check above vacuously pass.
  assert.ok(SOURCES.includes("import-hygiene.test.ts"), `scanned files: ${SOURCES.join(", ")}`);
});
