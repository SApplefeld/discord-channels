import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertTokenFileIsProtected,
  descriptorOwner,
  foreignGrants,
  unsafePosixMode,
} from "./credentials.ts";

const OWNER = "S-1-5-21-1-2-3-1001";

test("only the owner and the administrative identities may hold access", () => {
  const owned = `O:${OWNER}G:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${OWNER})`;

  assert.deepEqual(foreignGrants(owned), []);
  assert.deepEqual(descriptorOwner(owned), OWNER);
});

test("a grant to anyone else is a finding, alias or raw identifier", () => {
  const cases: Record<string, string> = {
    AU: `O:${OWNER}G:BAD:AI(A;ID;0x1301bf;;;AU)`,
    WD: `O:${OWNER}G:BAD:AI(A;ID;FA;;;WD)`,
    BU: `O:${OWNER}G:BAD:AI(A;ID;0x1200a9;;;BU)`,
    AC: `O:${OWNER}G:BAD:AI(A;ID;0x1200a9;;;AC)`,
    // Domain Users arrives as a full identifier with no alias at all, which is the domain-joined
    // case a list of known-dangerous aliases misses entirely.
    "S-1-5-21-1-2-3-513": `O:${OWNER}G:BAD:AI(A;ID;FA;;;S-1-5-21-1-2-3-513)`,
    "S-1-1-0": `O:${OWNER}G:BAD:AI(A;ID;FA;;;S-1-1-0)`,
  };

  for (const [trustee, sddl] of Object.entries(cases)) {
    assert.deepEqual(foreignGrants(sddl), [trustee], sddl);
  }
});

test("only entry types that actually grant are counted", () => {
  // AU in the type position is SYSTEM_AUDIT, not the Authenticated Users trustee of the same
  // spelling, and OA is an object-allowed entry that does grant.
  assert.deepEqual(foreignGrants(`O:${OWNER}G:BAD:PAI(D;;FA;;;WD)(A;;FA;;;BA)`), []);
  assert.deepEqual(foreignGrants(`O:${OWNER}G:BAD:PAI(AU;SA;FA;;;WD)`), [], "an audit entry grants nothing");
  assert.deepEqual(foreignGrants(`O:${OWNER}G:BAD:PAI(OA;;FA;;;WD)`), ["WD"]);
  assert.deepEqual(foreignGrants(`O:${OWNER}G:BAD:PAI(XA;;FA;;;AU;(x==1))`), ["AU"]);
  assert.deepEqual(foreignGrants("O:BAG:BA"), [], "a descriptor with no list grants nothing");
});

test("a POSIX mode is safe when nobody but the owner can reach the file", () => {
  assert.equal(unsafePosixMode(0o600), false);
  assert.equal(unsafePosixMode(0o400), false, "a read-only credential is hardened, not broken");
  assert.equal(unsafePosixMode(0o640), true, "group read is enough to steal the token");
  assert.equal(unsafePosixMode(0o604), true);
});

test(
  "a POSIX token file is refused unless it is owner-only",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "channels-cred-"));
    try {
      const file = path.join(directory, "bot.token");
      writeFileSync(file, "token", { mode: 0o600 });
      assert.doesNotThrow(() => assertTokenFileIsProtected(file));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a Windows token file readable by every account is refused",
  { skip: process.platform !== "win32" },
  () => {
    // The real check against a real access control list: the D: root on at least one of these
    // hosts grants Authenticated Users: Modify by inheritance, which is exactly this shape.
    const directory = mkdtempSync(path.join(os.tmpdir(), "channels-cred-"));
    try {
      const file = path.join(directory, "bot.token");
      writeFileSync(file, "token", "utf8");
      assert.doesNotThrow(
        () => assertTokenFileIsProtected(file),
        "a file in the user's own temp directory is reachable by nobody else",
      );

      execFileSync("icacls.exe", [file, "/grant", "*S-1-5-11:(R)"], { stdio: "ignore" });

      assert.throws(() => assertTokenFileIsProtected(file), /bot\.token grants access to AU/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a Windows token file in a directory every account can write is refused",
  { skip: process.platform !== "win32" },
  () => {
    // Delete-child on the directory is write on the file: the hardened file is deleted and
    // re-created attacker-owned, and the next start reads their token.
    const directory = mkdtempSync(path.join(os.tmpdir(), "channels-cred-"));
    try {
      const holder = path.join(directory, "tokens");
      execFileSync("cmd.exe", ["/c", "mkdir", holder], { stdio: "ignore" });
      const file = path.join(holder, "bot.token");
      writeFileSync(file, "token", "utf8");
      assert.doesNotThrow(() => assertTokenFileIsProtected(file));

      execFileSync("icacls.exe", [holder, "/grant", "*S-1-5-11:(M)"], { stdio: "ignore" });

      assert.throws(() => assertTokenFileIsProtected(file), /tokens grants access to AU/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a token file the check cannot read is refused rather than assumed safe", () => {
  assert.throws(
    () => assertTokenFileIsProtected(path.join(os.tmpdir(), "channels-no-such-file.token")),
    /token file/,
  );
});
