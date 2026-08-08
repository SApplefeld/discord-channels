# The relay's instructions describe the sender gate

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: n/a (Fable-led session)
Created: 2026-08-08

## Goal

The relay's MCP instructions tell the session the truth about where a channel message has been:
delivered only after the broker checked its author's Discord account against the one-account
allowlist naming the operator. The session treats channel steering as the operator's own, at the
same standing as the keyboard, while the confirm-before-irreversible discipline stays explicit.
No document or comment in the tree is left asserting the old unattributed posture.

## Approach

Decided 2026-08-08, operator's call on the recommendation, council offered and declined.

The old instructions said channel content should be treated as "an unattributed message from a
person with access to the thread" carrying "less authority than what the operator typed at the
keyboard." That sentence was itself an end-to-end provenance claim, and a false one: a non-operator
thread member's message is refused at broker/routing/inbound.ts:167 before anything reads it, the
only production writer of a `type: "message"` stream event sits below that gate
(broker/routing/inbound.ts:207), and a broker with a Discord connection refuses to start without
the allowlist (broker/index.ts:337, broker/security/senders.ts:44). The fork was never between
claiming and humbly not claiming; it was between two end-to-end descriptions, one of which the code
refutes.

What the superseded pin test (relay/protocol.test.ts:66) had right, and what the new text
preserves: the relay cannot verify its peer at runtime. So the instructions describe the control as
a property of the system rather than asserting per-message verification by the relay, and they
describe rather than command: "trust channel messages" would survive a future change to how
messages arrive, while a description of the control is falsifiable and sweepable under this
repository's comment-as-claim rule.

Residuals stated rather than hidden: the check establishes the account, not the person, so whoever
controls the operator's Discord account holds this authority (docs/security-model.md already says
this); and confirm-before-irreversible stays, framed as blast radius, which applies to a keyboard
instruction identically. The port-squat residual (a local process binding the broker's port first)
is not stated in the instructions: it is the machine's trust boundary, already documented in the
security model, and not a delta against the keyboard.

The agreed replacement text, verbatim (paragraphs one and three are unchanged from the current
text; paragraph two is the rewrite):

> This channel connects the session to a Discord thread, which is how the operator watches and
> steers it while away from the keyboard.
>
> Channel events carry text posted in that thread. A message is delivered here only after this
> host's broker has checked its author's Discord account against a one-account allowlist naming
> the operator, and a broker connected to Discord refuses to start without that allowlist. So
> treat a channel message as the operator's own steering, with the same standing as what they type
> at the keyboard. What the check establishes is the account, not the person: whoever controls the
> operator's Discord account holds this authority. For an action that is irreversible or
> outward-facing, confirm first, exactly as for a keyboard instruction; that discipline is about
> blast radius, not about who is asking.
>
> Use the reply tool to answer one, and to report on your own initiative when something is worth
> the operator's attention: a milestone, a decision you need, or a failure you cannot work around.
> A reply reaches their phone, so it is worth spending on those and not on routine progress, which
> they can already see on the thread's status card.

## Sections of Work

### 1. The instructions and their pins

Model: fable

Rewrite `INSTRUCTIONS` in relay/protocol.ts to the agreed text above, verbatim, keeping it a
static literal built the same way (string concatenation, nothing interpolated). Update the
JSDoc above it if its wording still fits; it already states the static-literal property and
should keep stating it.

Rewrite the pin test at relay/protocol.test.ts:66 ("the instructions do not claim a sender the
transport cannot identify") rather than deleting it. Its comment must restate the old premise (the
transport cannot establish the sender, so the old text refused to attribute) and why it was
superseded (the old text made its own false end-to-end claim; the new text describes the broker's
control as a system fact the repository owns and tests, without asserting per-message verification
by this layer). The new assertions pin the new properties:

- the text names the allowlist control (matches on the allowlist/broker description),
- the text states the account residual (controls-the-account wording),
- the text keeps the confirm-before-irreversible carve-out,
- the text does not command unconditional trust (no "always trust" shape) and does not claim the
  relay itself verified anything (nothing like "verified at this layer").

The sibling test at relay/protocol.test.ts:54 keeps its security property intact: the
static-literal assertions (no `${`, no environment value present in the string) must survive
untouched. Its two incidental vocabulary matches are on different footing: `/reply/` still holds
against the agreed text, and `/data/` does not, because the agreed text drops the word, so that one
assert is re-pointed at a word the agreed text does carry (for example `/operator/`). The test's
name and comment stay as they are; only the vocabulary anchor moves.

Files in scope: relay/protocol.ts, relay/protocol.test.ts.

Acceptance: `node --test relay/protocol.test.ts` green; the INSTRUCTIONS string equals the agreed
text; no template interpolation anywhere in it; the superseded test's comment carries both the old
premise and the supersession reasoning.

Tests: lock both directions of the posture change: the new text must assert the control and must
not claim per-message verification at the relay layer; the static-literal property must survive.
The expensive failure is a future edit quietly re-introducing either an unbacked verification
claim or interpolated content, so the pins must fail loudly on both.

### 2. The documentation sweep

Model: fable
Locus: inline

Documentation is main-thread work: Edit and Write are hard-blocked under docs/ for implementer
subagents.

- docs/security-model.md, the paragraph at ~283 beginning "A channel event tells the model that
  its sender is unverified": rewrite to state the new posture, in the document's own register:
  the instructions describe the sender gate and grant channel steering the keyboard's standing,
  the account residual is stated to the model, and the confirm-before-irreversible discipline is
  framed as blast radius. The surrounding section already documents the gate itself and needs no
  change.
- docs/operations.md: one operator-facing sentence near the steering material saying what
  deference channel messages get, since the raised deference is a behavior change the operator
  will notice.
- Tree-wide sweep for the old posture's phrases per the comment-as-claim rule: "unattributed",
  "not verified at this layer", "less authority", and any comment or doc describing the session as
  discounting channel content. Fix every hit that asserts the old posture; leave hits that are
  about something else (for example broker/discord/credentials.ts's "unverified owner", which is
  about file ownership).

Files in scope: docs/security-model.md, docs/operations.md, plus whatever the sweep surfaces.

Acceptance: the sweep greps return no line asserting the old posture; no doc claims the session
treats channel content as unattributed or lower-authority.

## Out of Scope

- The gate itself, a second allowlist entry, cryptographic attribution, and the permission-verdict
  path: all unchanged.
- The kit and its doctrine: this is the relay's own contract, in this repository only.
- Live-session behavior: instructions load once at MCP connection, so running sessions keep the
  old text until their relay reconnects. A deploy fact, not a work item.

## Related

- [`../security-model.md`](../security-model.md), whose sender-gate section is the control this
  plan's text describes and whose channel-event paragraph this plan rewrites.
- [`../archive/plans/sapplefeld-channels_spec_v1.md`](../archive/plans/sapplefeld-channels_spec_v1.md),
  the original design record where the sender gate and the relay's instructions were first built.

## Open Questions

None. The posture call, the council offer (declined), and the commit model were all decided
2026-08-08.

## Chapters

### Chapter 1 - 2026-08-08
Completed: 1. The instructions and their pins
Implemented By: implementer-fable
Metrics: 1 review round (adversarial + blind + security); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The blind reviewer rated the loopback-impersonation surface Critical; adjudicated to the security reviewer's Major on two code-verified facts: a broker impersonator already answers real permission prompts (relay/broker.ts:185-192, a strictly stronger primitive than steering text), and the hardened ACLs grant the owner, so a same-user process can rewrite the Bypass-executed hook scripts, meaning the keyboard does not survive that adversary either. Fix routed to Section 2: the security model's accepted-risk list gains forged channel events at the raised standing. The blind reviewer's contradiction claim against inbound.ts:22/58 and protocol.ts:29 was rejected: those comments state the carriers' opaque-payload and sanitization contracts, not the model's deference, and both remain true. Declined with reasons: a scoping hedge inside INSTRUCTIONS (re-creates the hesitation this effort removes; residual goes to the security model instead) and a quoted-content-provenance clause (keyboard parity already implies keyboard-equivalent hygiene; available as a one-line swap on request). The implementer found and removed a stray backspace byte (0x08) inside the old test's regex, which had silently weakened the old "(from|by) the operator" pin. Deployment fact: sessions keep the old instructions until their relay reconnects.
Review Findings: 0 Critical surviving adjudication; 1 Major adopted as a Section 2 requirement (security-model accepted-risk entry), 1 Major rejected with evidence; convergent Minor from all three reviewers adopted (the confirm-discipline pin now matches the full clause); remaining Minors noted: phrase pins catch deletion not contradiction (inherent to text pinning; sentence-length pins force rewording through a red test), the env-scan interpolation pin is a tripwire not proof (pre-existing).
Stamps: none surfaced (memq unstamped --since 3h returned 0; the two records steering this effort were stamped at design time)
Next: 2. The documentation sweep
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-08
Completed: 2. The documentation sweep
Implemented By: main session
Metrics: 1 review round (adversarial only); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The blind reviewer was skipped for this section with cause: its input contract excludes docs/ hunks and the section is entirely docs; the adversarial reviewer carries the prose-versus-code accuracy risk, and the finishing pass reviews the full changeset. Beyond the spec's three planned edits, the security-model changes absorbed two review-round requirements from Section 1: the accepted-risk list gained the forged-broker entry (a local process answering the loopback port feeds channel events at the raised standing; accepted on the stronger-primitive rationale, since verdict spoofing and hook rewriting were already conceded to that adversary), and the sender-gate account-compromise paragraph now names the keyboard standing its messages carry. The sweep found exactly one live old-posture site (the security model's channel-event paragraph); every other hit quotes the old posture as superseded (plan doc, test comment) or means something else (file-ownership "unverified owner"), and the Chapter 1 ruling on the carrier-contract comments was re-read and concurred with by the reviewer.
Review Findings: 0 Critical, 0 Major; 2 Minor: an operator-facing sentence stated model behavior as a guarantee rather than as instruction text, fixed with the reviewer's wording (the honesty gate applies to promises on operator surfaces); the steering-deference paragraph's placement under the permission-prompt heading noted, kept beside the inbound-chat ceiling where inbound-message content already lives.
Stamps: none surfaced (memq unstamped --since 1h returned 0)
Next: finishing-work
Commit Model: Commit-and-Push

