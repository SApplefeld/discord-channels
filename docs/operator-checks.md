# Operator checks

Four checks that need a human at a terminal, a phone, or an Administrator prompt. Each states what it
proves, the exact steps, and what to do with the answer. Record results in the plan doc's Chapters.

Check A gates sections 5 and 6 of the plan. Checks B and D are cheap and change the design if they
come back negative. Check C cannot run until section 4 exists.

---

## A. Does a channel survive a cswap seat rotation?

**Proves:** the single assumption the whole message path rests on. A channel is a local subprocess
with no cloud object to orphan, and `claude-swap` rewrites credential files without restarting Claude
Code, so it should ride straight through a swap. Nobody has watched it happen.

**Blocks:** sections 5 and 6. Sections 1 through 4 do not depend on it.

**Why three swaps and not one:** Remote Control also worked for a while after a rotation and only
failed permanently after repeated ones. A single passing swap proves nothing.

### Steps

1. Confirm Bun is present, since the shipped channel plugins are Bun scripts:
   ```
   bun --version
   ```
   If that fails, install Bun first.

2. In any Claude Code session, install the demo channel and exit:
   ```
   /plugin install fakechat@claude-plugins-official
   ```
   Choose the **user** scope so it works from any directory. If the marketplace is missing, add it
   with `/plugin marketplace add anthropics/claude-plugins-official`, and if the plugin is missing,
   refresh with `/plugin marketplace update claude-plugins-official`.

3. Relaunch with the channel on. `fakechat` is on the approved allowlist, so **no development flag
   and no warning dialog**:
   ```
   claude --channels plugin:fakechat@claude-plugins-official
   ```
   The startup banner should carry a dim line confirming the channel registered.

4. Open <http://localhost:8787>, send `what directory are you in?`, and confirm two things: the
   terminal shows an inbound line like `← fakechat · web: …`, and Claude's answer appears back in the
   browser. The reply direction matters as much as the inbound one; they are different code paths.
   The first reply triggers a permission prompt in the terminal. Approve it.

   `fakechat` serves its UI on 8787, which is also the broker's default port. If the broker is
   installed by the time this check runs, stop it first; otherwise one of the two fails to bind and
   the check measures the wrong thing.

5. In a second terminal, rotate the seat:
   ```
   cswap switch
   ```
   Note which account it moved to.

6. Return to the browser and send another message. Start a timer. **A pass is the message arriving
   and being answered within about thirty seconds.**

7. **Repeat steps 5 and 6 two more times**, so three rotations total, noting the account each time.

### Recording the result

For each of the three swaps, write down the account moved to, whether the inbound message arrived,
and whether the reply came back. A partial pass (inbound works, replies stop, or vice versa) is a
distinct and important result, not a fail.

### Kill condition

If delivery stops in either direction after any swap and does not recover, **stop building sections 5
and 6.** Sections 1 through 4 still ship and still solve the visibility half of the problem. The
fallback for the messaging half is several pre-provisioned Discord bots on the shipped, allowlisted
Discord plugin, leased per launch by setting `DISCORD_BOT_TOKEN` and `DISCORD_STATE_DIR` in the
wrapper. That loses automatic thread-per-session and the `/clear` behavior.

---

## B. Does `/clear` fire `SessionStart` with `source: "clear"`?

**Proves:** that an outside process can tell a session was replaced inside a still-running process.
The whole thread-per-work-topic behavior depends on it.

**Risk level: low.** The `source` field is confirmed to exist and to track the real trigger, observed
reading `startup` on a fresh session and `resume` on a resumed one. This check closes the last gap.

### Steps

1. From this repository, launch an interactive session with the probe harness attached:
   ```
   claude --settings tools/probe-hook-payload.json
   ```

2. Type `/clear` at the prompt.

3. Exit, then read what the hooks captured:
   ```
   Get-Content tools\hook-capture.jsonl
   ```

**Pass:** two `SessionStart` lines, the second carrying a **different `session_id`** and
`"source":"clear"`.

**If it comes back negative:** the session ID still changes, so the broker can detect a replacement by
watching for a new `session_id` on any hook event from a process token it already knows. Slightly
less clean, same outcome. Tell the executor to use that instead.

---

## C. Does a thread name stay pinned in the mobile header while scrolling?

**Proves:** whether the always-visible status line works as designed on a phone.

**Cannot run until section 4 exists**, since it needs a real bot posting real threads.

### Steps

Open any thread in the Discord mobile app, scroll down through a long message history, and check
whether the thread name stays in the top bar.

**If negative:** the design barely moves. The thread **list** view still shows every session and its
state, which is the more valuable half. Only the in-thread header is lost.

---

## D. Does a local managed-settings file control channels on this machine?

**Proves:** the most valuable unknown left. `channelsEnabled` and `allowedChannelPlugins` can only be
set in managed settings, and on Windows managed settings can be delivered as a **local file**, which
is **machine-scoped rather than account-scoped**. If a local file is honored, then one file per host
survives every cswap rotation, and delivery can never silently die because the seat rotated onto an
account without channels enabled. It may also let a custom relay be allowlisted without the
development flag, on the personal-Max host as well as the two organization ones.

**This check is deliberately reversible and uses no custom plugin.** It sets the allowlist to empty,
which should block *everything*, and watches whether the shipped demo channel gets refused. If it
does, the file is being read.

> **This writes to a security-policy file and needs Administrator.** Managed settings are the highest
> precedence layer and cannot be overridden by user or project settings, which is exactly why it is
> yours to run rather than an agent's. The rollback is deleting the file.

### Steps

1. Confirm the demo channel currently registers (this is the control):
   ```
   claude --channels plugin:fakechat@claude-plugins-official
   ```
   The startup notice should say the channel is active. Exit.

2. In an **Administrator** PowerShell, create the managed settings file:
   ```powershell
   New-Item -ItemType Directory -Force -Path 'C:\Program Files\ClaudeCode'
   Set-Content -Path 'C:\Program Files\ClaudeCode\managed-settings.json' -Encoding utf8 -Value '{ "channelsEnabled": true, "allowedChannelPlugins": [] }'
   ```

3. Relaunch the same command as step 1.

   **Pass:** the channel does **not** register, and the startup notice says the plugin is not on the
   organization's approved list. That means the local file is honored on this account.

   **Fail:** the channel registers exactly as before, meaning the local file is ignored here and the
   allowlist can only come from the organization's server-managed settings.

4. **Remove the file regardless of the result**, or every channel on this machine stays blocked:
   ```powershell
   Remove-Item 'C:\Program Files\ClaudeCode\managed-settings.json'
   ```

### What the answer changes

**If it passes:** each host gets a managed-settings file naming the relay plugin, and there is no
development flag and no launch dialog anywhere. That also restores the option of an unattended
supervisor restarting a crashed session, which the dialog otherwise forecloses. Note the allowlist
replaces the Anthropic default entirely, so any shipped channel plugin still wanted must be listed
alongside the relay.

**If it fails:** the two organization hosts use server-managed settings through the admin console, and
the personal-Max host keeps `--dangerously-load-development-channels` and its one keypress at launch.
