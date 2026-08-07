# Operator checks

Five checks that need a human at a terminal, a phone, or an Administrator prompt. Each states what it
proves, its result, the exact steps, and what the answer settled.

**Checks A through D were run on 2026-08-06 and all four passed. Check E passed its rendering half
on 2026-08-07; its per-session off switch half is open.** The procedures are kept because they are
also how to re-check a new host: none of these results is inferable from the code, and two of them
would change the design if a future host answered differently.

Two results changed the design rather than merely confirming it. Check D means channel settings are
machine-scoped, which permanently closes the silent-delivery-death hole on every host, and it means
the SCOTT host can drop its development flag once the relay is packaged as a plugin. Check B means
the broker's supersession branch reads a real signal rather than an inferred one.

---

## A. Does a channel survive a cswap seat rotation?

**Result: passed, 2026-08-06.** A channel kept delivering in both directions across three
consecutive `cswap` rotations. The message path this whole project rests on is confirmed rather than
reasoned about, and the pre-provisioned-bot fallback below is not needed.

**Proves:** the single assumption the message path rests on. A channel is a local subprocess with no
cloud object to orphan, and `claude-swap` rewrites credential files without restarting Claude Code,
so it rides straight through a swap.

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

   `fakechat` serves its UI on 8787, which is also the broker's default port. On a host where the
   broker is already installed, stop it first; otherwise one of the two fails to bind and the check
   measures the wrong thing.

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

If delivery stops in either direction after any swap and does not recover on a new host, **that host
cannot carry the message half.** The registry, the threads, and the status cards still work and still
solve the visibility half of the problem. The fallback for the messaging half is several
pre-provisioned Discord bots on the shipped, allowlisted Discord plugin, leased per launch by setting
`DISCORD_BOT_TOKEN` and `DISCORD_STATE_DIR` in the wrapper. That loses automatic thread-per-session
and the `/clear` behavior.

---

## B. Does `/clear` fire `SessionStart` with `source: "clear"`?

**Result: passed with captured payloads, 2026-08-06.** `/clear` fires `SessionStart` carrying
`"source":"clear"` and a **new `session_id`**, which is exactly what the broker's supersession branch
reads: the old record is marked ended and a new one is created under the same process token. The
fallback (detecting a changed `session_id` on any hook event) is not needed and is not implemented.

The same capture shows `SessionEnd` fires on a clean exit, carrying the ending session's ID. **The
broker does not use it.** A hard kill fires no hook, so relay stdio closing and the heartbeat
backstop remain the death signals, and the content-free intake accepts only `SessionStart`,
`PostToolUse`, and `Stop`. A `SessionEnd` post would be refused with a 400. The mirror route keeps
its own vocabulary of `UserPromptSubmit` and `Stop` and shares nothing with that list. The signal
exists and is free if a later change wants a precise clean-exit case.

**Proves:** that an outside process can tell a session was replaced inside a still-running process.
The whole thread-per-work-topic behavior depends on it.

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

**If it comes back negative on a future host:** the session ID still changes, so the broker could
detect a replacement by watching for a new `session_id` on any hook event from a process token it
already knows. That path is not built.

---

## C. Does a thread name stay pinned in the mobile header while scrolling?

**Result: passed, 2026-08-06.** The thread name stays in the top bar through a long scroll, so both
halves of the design work: the in-thread header and the thread-list dashboard.

**Proves:** whether the always-visible status line works as designed on a phone. Thread names are
rendered glyph-first for exactly this reason, because the list view truncates hard and the actionable
part has to survive truncation.

### Steps

Open any thread in the Discord mobile app, scroll down through a long message history, and check
whether the thread name stays in the top bar.

**If negative on a future device:** the design barely moves. The thread **list** view still shows
every session and its state, which is the more valuable half. Only the in-thread header is lost.

---

## D. Does a local managed-settings file control channels on this machine?

**Result: passed, 2026-08-06.** A local managed-settings file **is** honored on a personal account
with no organization. This was the most valuable unknown in the design, and it settled two things.

**Channel settings are machine-scoped, not account-scoped.** `channelsEnabled` and
`allowedChannelPlugins` can be set once per host and survive every `cswap` rotation, so a rotation
onto an account without channels enabled can no longer kill message delivery. That closes the
silent-delivery-death hole on every host, SCOTT included, and it is the failure mode
[`operations.md`](operations.md) describes the status card as existing to reveal.

**SCOTT can drop `--dangerously-load-development-channels`**, and with it the launch dialog, once the
relay is packaged as a plugin and named in that file. SCOTT keeps the flag today because the
allowlist route requires a plugin to allowlist and the relay is not yet packaged as one. Removing the
dialog on every host restores the option of an unattended supervisor that restarts a crashed session.

**Proves:** whether `channelsEnabled` and `allowedChannelPlugins`, which can only be set in managed
settings, can be delivered as a local file on a host with no organization behind it.

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

**On a host where it passes:** that host gets a managed-settings file naming the relay plugin, and
needs no development flag and no launch dialog. Note the allowlist replaces the Anthropic default
entirely, so any shipped channel plugin still wanted must be listed alongside the relay.

**On a host where it fails:** an organization-owned host uses server-managed settings through the
admin console instead, and a personal-account host keeps
`--dangerously-load-development-channels` and its one keypress at launch.

---

## E. Does the mirror render as the escape assumes, and does `-NoMirror` stop it?

**Result: steps 1, 2, and 3 passed, 2026-08-07. Step 4 is open.** Both rendering claims the escape
rests on are now observed rather than inferred. In a mirrored reply on the Discord mobile client, a
`<@id>` mention and a `<t:...:R>` timestamp inside a fenced code block, which the escape deliberately
leaves untouched, rendered as literal text with no pill and no chip; the same three outside the
fence, which the escape does neutralize, rendered as literal characters with the backslashes
invisible and no blockquote. A line-leading `>` inside a fence renders as a visible `\>`, which is
the accepted cost of escaping it unconditionally so the attribution cannot be forged even if the
fence model is wrong. Step 5's stale-install refusal passed on this host before the re-install.

One cosmetic finding, recorded rather than fixed here: the attribution line is a blockquote and
Discord continues a blockquote onto the lines that follow it, so a mirrored prompt renders entirely
inside quote bars while a reply does not, because a reply's leading code fence ends the quote.

**Still open.** This is the one behavior no test in this repository can reach. The mirror's
sanitization is built on two claims about how Discord renders a message, and the per-session switch
depends on Claude Code interpolating an environment variable into a hook header, which only a real
session can exercise. Everything either side of that seam is pinned by tests; the seam itself is not.

**What it proves.** That mirrored content cannot draw a mention pill, a timestamp chip, or a copy of
the renderer's own attribution line inside the channel where tool approvals are answered, and that
the per-session off switch actually stops mirror posts on a real host.

### Steps

1. From a wrapped session, get Claude to reply with a fenced code block containing
   `<@000000000000000000>` and `<t:1700000000:R>` on their own lines, and a line beginning `> `.
2. Read the thread on a phone. **Pass:** all three arrive as literal text inside the code block, no
   pill, no relative-time chip, no second blockquote beside the message's own attribution line.
   **Fail:** any of them renders. The fix is confined to the escape in `broker/discord/render.ts`:
   drop the fence exemption so those characters are escaped everywhere, accepting the visible
   backslashes in code that the exemption exists to avoid.
3. Repeat with the same three constructs outside a code block. They must arrive escaped either way;
   this half is pinned by tests and is here to confirm the tests describe the real surface.
4. Launch a second session with `Enter-ClaudeSession -NoMirror` while the first keeps running. Type a
   prompt in each. **Pass:** the first session's thread carries both the prompt and the reply, the
   second session's thread carries neither, and the second session's status card keeps ticking.
   **Fail either way round:** an unmirrored session that mirrors is a privacy control that failed
   open, and a mirrored session that goes quiet means the header is reaching the broker from the
   wrong session.
5. On a host installed before the switch existed, confirm `-NoMirror` refuses to launch and names the
   installer, rather than starting a session that mirrors.

### Recording the result

Write the outcome of each step here the way checks A through D record theirs. Step 2 is the one that
can change the design; the rest confirm the wiring.
