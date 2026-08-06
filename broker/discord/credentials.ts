// Protection checks for the file a bot token is read from.
//
// A bot token is a bearer credential: anything that can read the file can post as this bot, and
// anything that can write it can point the broker at a bot in a server the operator does not own,
// where the broker would then publish this host's whole session inventory. The `D:` root on at
// least one of these hosts grants `Authenticated Users: Modify` by inheritance, so a token file
// dropped next to the checkout is readable and writable by every account on the machine.
//
// The containing directory is held to the same standard as the file. Delete-child on a directory
// is equivalent to write on everything in it: a hardened token file can be deleted and re-created
// by an attacker, owned by them, with a clean owner-only list, and the next start would read it
// and connect to their bot.
//
// The check is refuse-by-default and platform-split, because the two platforms answer completely
// different questions. POSIX permission bits carry the answer directly. On Windows they do not
// exist: `fs.stat` synthesizes a mode from the read-only attribute alone and would report a
// world-writable file as 0o666, so the discretionary access control list is read instead, as SDDL,
// which names its principals by security identifier and so does not depend on the display
// language of the account names.
import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

/**
 * SDDL access control entry types that grant. `A` is access-allowed, `OA` its object form, and
 * `XA` and `ZA` their callback forms. Everything else either denies (`D`, `OD`, `XD`, `ZD`) or is
 * an audit or label entry (`AU`, `AL`, `ML`, `SP`), none of which hands anyone access. `AU` in
 * particular is SYSTEM_AUDIT here and is not the Authenticated Users trustee of the same spelling.
 */
const ALLOW_TYPES: ReadonlySet<string> = new Set(["A", "OA", "XA", "ZA"]);

/**
 * Trustees that may hold access to a token file without it being a finding: the file's own owner,
 * the local Administrators group, and SYSTEM. Both the SDDL alias and the raw identifier are
 * listed, since a descriptor may carry either. `OW` is the owner-rights identity.
 *
 * This is an allowlist rather than a list of dangerous principals on purpose. A denylist misses
 * whatever it did not think of, and the cases it misses here are ordinary: an application-package
 * identity, or a domain group such as Domain Users, which arrives as a raw `S-1-5-21-...-513` with
 * no alias at all.
 */
const PERMITTED_TRUSTEES: ReadonlySet<string> = new Set([
  "BA",
  "S-1-5-32-544",
  "SY",
  "S-1-5-18",
  "OW",
  "S-1-3-4",
]);

let cachedCurrentUserSid: string | null | undefined;

/**
 * This process's own SID, or null if it could not be determined. Cached for the life of the
 * process: the identity a broker runs as does not change between one hook post and the next.
 */
function currentWindowsUserSid(): string | null {
  if (cachedCurrentUserSid !== undefined) return cachedCurrentUserSid;
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    cachedCurrentUserSid = output === "" ? null : output.toUpperCase();
  } catch {
    cachedCurrentUserSid = null;
  }
  return cachedCurrentUserSid;
}

/** The owner from a security descriptor's `O:` field, upper-cased, or null when it carries none. */
export function descriptorOwner(sddl: string): string | null {
  const owner = /(?:^|[^A-Z])O:([^:]+?)(?=[GDS]:|$)/.exec(sddl.toUpperCase());
  return owner === null ? null : owner[1].trim();
}

/**
 * Every trustee granted access by a security descriptor that is neither its owner nor an
 * administrative identity.
 *
 * SDDL entries look like `(A;ID;FA;;;WD)`: type, flags, rights, two object GUIDs, and the trustee.
 */
export function foreignGrants(sddl: string): string[] {
  const dacl = /D:(?:[A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (dacl === null) return [];

  const owner = descriptorOwner(sddl);
  const found = new Set<string>();
  for (const [, entry] of dacl[1].matchAll(/\(([^)]*)\)/g)) {
    const fields = entry.split(";");
    if (fields.length < 6) continue;
    if (!ALLOW_TYPES.has(fields[0].trim().toUpperCase())) continue;
    const trustee = fields[5].trim().toUpperCase();
    if (trustee === "" || trustee === owner) continue;
    if (PERMITTED_TRUSTEES.has(trustee)) continue;
    found.add(trustee);
  }
  return [...found];
}

/**
 * True when a POSIX mode grants any access at all beyond the owner. Owner-writability is not
 * required: a read-only credential is a hardened one, not a broken one.
 */
export function unsafePosixMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** The security descriptors of several paths, in the order asked for. */
function windowsSddl(paths: string[]): string[] {
  // One spawn, at broker start, only when a token file is configured. PowerShell is the only
  // access-control reader on the platform, and the SDDL form is what makes the result parseable.
  //
  // Each path goes in as a single-quoted PowerShell literal, where the only escape is a doubled
  // quote, so nothing in a path is interpreted. ErrorActionPreference makes a missing or
  // unreadable path a terminating error: by default Get-Acl reports one to stderr and exits zero,
  // which would hand this check an empty string and read as "nothing foreign here".
  const literals = paths.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; @(${literals}) | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Throws unless the token file and the directory holding it are reachable only by their owner and
 * the machine's administrative identities. The message names the path and the offending trustee,
 * never the contents.
 */
export function assertTokenFileIsProtected(
  file: string,
  platform: string = process.platform,
  // Injectable for the same reason `platform` is: a test cannot elevate to change a real file's
  // owner, so this is how the owner-mismatch path is exercised against a real, self-owned file
  // instead.
  currentUserSid: () => string | null = currentWindowsUserSid,
): void {
  const directory = path.dirname(path.resolve(file));

  // Checked on both platforms, before anything else: a reparse point (a symlink or, on Windows, a
  // junction or mount point) can pass every check below against its current target and then be
  // re-pointed at an attacker-controlled file the moment after. lstat, not stat, is what tells the
  // two apart, since stat follows the link.
  for (const target of [file, directory]) {
    let info;
    try {
      info = lstatSync(target);
    } catch (error) {
      // A missing or unreadable path is reported the same way the rest of this function reports
      // one: naming the token file, not the internal target that happened to fail, since a
      // directory that vanished out from under its file is still the token file's problem.
      throw new Error(`cannot read the access control list of the token file ${file}: ${String(error)}`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `${target} is a reparse point (a symlink, junction, or mount point); refusing to trust a ` +
          `path whose target can change after this check runs`,
      );
    }
  }

  if (platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    for (const target of [file, directory]) {
      const stat = statSync(target);
      // Ownership, not just mode: chmod 600 set by an account that is not this process's own, or
      // root, still means that other account controls the file's mode and could loosen it again a
      // moment after this check passes.
      if (uid !== null && stat.uid !== 0 && stat.uid !== uid) {
        throw new Error(
          `${target} is owned by uid ${stat.uid}, neither this process's account (uid ${uid}) nor ` +
            `root; take ownership of it as the broker's own account before starting`,
        );
      }
      if (unsafePosixMode(stat.mode)) {
        throw new Error(
          `${target} is readable, writable, or listable beyond its owner; restrict it to the ` +
            `broker's account (chmod 600 on the token file, 700 on its directory) before starting`,
        );
      }
    }
    return;
  }

  let descriptors: string[];
  try {
    descriptors = windowsSddl([file, directory]);
  } catch (error) {
    // A check that cannot run is not a check that passed.
    throw new Error(`cannot read the access control list of the token file ${file}: ${String(error)}`);
  }

  if (descriptors.length !== 2) {
    throw new Error(
      `the access control lists of the token file ${file} and its directory could not be read`,
    );
  }

  const currentSid = currentUserSid();

  for (const [index, target] of [file, directory].entries()) {
    const sddl = descriptors[index];
    // A descriptor with no DACL section is not one this check understood, and an unrecognized
    // answer is not a passing one.
    if (!/D:/.test(sddl)) {
      throw new Error(`the access control list of ${target} could not be read as a security descriptor`);
    }

    // The owner is exempt from the grant scan below by construction (foreignGrants skips its own
    // trustee), so an unverified owner turns that exemption into a hole: a file planted by any
    // account on a shared root is owned by that account, hardened to itself with a clean ACL, and
    // would otherwise pass. The owner must be this process's own account or an administrative
    // identity, not merely whoever happened to create the file.
    const owner = descriptorOwner(sddl);
    if (owner === null) {
      throw new Error(`the access control list of ${target} names no owner`);
    }
    if (owner !== currentSid && !PERMITTED_TRUSTEES.has(owner)) {
      throw new Error(
        `${target} is owned by ${owner}, which is neither this process's account nor an ` +
          `administrative identity; it may have been planted by another account, so take ` +
          `ownership of it as the broker's own account before starting`,
      );
    }

    const foreign = foreignGrants(sddl);
    if (foreign.length > 0) {
      throw new Error(
        `${target} grants access to ${foreign.join(", ")}, which is broader than its owner and ` +
          `the machine's administrators; remove the inherited permissions before starting`,
      );
    }
  }
}
