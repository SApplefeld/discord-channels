// Shared by the two entry points this repository has, the broker daemon and the relay, because both
// run as source under Node's type stripping and both are also imported by tests.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when the given module is the program Node was told to run, rather than an import.
 *
 * Compared as resolved file URLs, and case-insensitively on Windows, where the same file reaches
 * argv as `D:\...` or `d:\...` or an 8.3 short path. A plain string comparison makes
 * `node broker/index.ts` exit zero having started nothing.
 */
export function runDirectly(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = resolve(entry);
  try {
    // Expands an 8.3 short path to the long form import.meta.url carries.
    real = realpathSync.native(real);
  } catch {
    // A path that cannot be resolved cannot be this module either.
  }
  const invoked = pathToFileURL(real).href;
  return process.platform === "win32"
    ? invoked.toLowerCase() === moduleUrl.toLowerCase()
    : invoked === moduleUrl;
}
