# channels: the fleet card drops accounts claude-swap has retired, v1

Status: In Progress
Commit Model: Branch-and-PR. Work on branch `retired-account-suppression`, push to `origin`, open a PR against `main`, never push directly to `main`.
Created: 2026-09-15
Worker: the `dev` persona, after its process keeper plan (`agent_persona/docs/plans/agent_persona_process-keeper_v1.md`) closes. The coordinator persona hands it over then. No rush is attached.
Checkout: the live broker runs from `D:\Discord-Channels` on `main`, so the worker builds in a separate git worktree for the branch rather than switching this checkout, which would change the running broker's code underneath it.

## Goal

The fleet card in Discord shows the same accounts `cswap watch` shows. Today it shows every account claude-swap has ever polled, so an account the operator retired keeps rendering, with stale numbers and a failure marker, for as long as the cache file remembers it.

## Root cause

The usage cache reader (`broker/usage/cache.ts`) walks every numbered entry in claude-swap's `cache/usage.json` and renders each one. claude-swap's `remove` command deletes an account from `sequence.json`, both from its `sequence` rotation array and from its `accounts` identity map, and does not prune the matching entry from `cache/usage.json`. So the cache file is the wrong membership authority. The reader already opens `sequence.json` for display identity and the active marker, so the membership fact is in a file it holds and it simply is not consulted.

On this machine today, `cache/usage.json` carries accounts 1 through 8. `sequence.json` carries 1, 4, 5, 6, 7 and 8. Accounts 2 and 3 are the retired pair: claude-swap's log records the removal of account 3, and both entries in the cache have been failing every poll since.

The reader's own comment states that the `sequence` array is deliberately not read, and a test pins that the reading is ordered by account number rather than by rotation order. Neither of those changes here. Ordering stays ascending by number. What changes is which accounts are in the list at all.

## Related plans

- [../archive/plans/channels_usage-card_spec_v1.md](../archive/plans/channels_usage-card_spec_v1.md): the round that built the fleet card and the two-file reader this round narrows.
- [../archive/plans/channels_fleet-card-layout_spec_v1.md](../archive/plans/channels_fleet-card-layout_spec_v1.md): the per-account layout. Unchanged by this round.

## Decisions taken at scoping (2026-09-15)

**Membership comes from the `accounts` identity map in `sequence.json`, not from the `sequence` array.** The identity map is the file's statement of which accounts exist, and the reader already looks every account up in it. The rotation array says which of those accounts are in the switching order, a narrower fact. On the live file the two agree, so the choice costs nothing today, and the map is the one whose absence the reader already has a story for. A worker who finds claude-swap can hold an account in the map but out of the rotation, and the operator wants those hidden too, raises it rather than widening the rule.

**An unreadable or malformed `sequence.json` keeps today's behavior: every cached account renders, unlabelled.** The reader's design is that numbers over no card wins, and the identity file failing was already a case it survives. A membership filter that turned an unreadable identity file into an empty card would trade a labelling loss for a total loss. So the filter applies only when the identity map was read.

**Retired accounts are dropped, not greyed.** The operator asked for them to stop displaying. A greyed row is a different feature with a layout cost and no ask behind it.

## Sections of Work

### Section 1: filter the reading by the identity map

Model: sonnet. One file of logic, one test file, a clear contract, an existing sibling pattern (the identity lookup on the same map) to mimic.

1. In `broker/usage/cache.ts`, when `sequence.json` parsed and its `accounts` value is a record, keep only the cached entries whose key is present in that record. When the identity map was not read, keep every cached entry, exactly as today. The `MAX_USAGE_ACCOUNTS` cap counts accounts that survive the filter, for the same reason the cap already counts readable entries rather than raw ones.
2. Update the module's header comment and the `accountEntries` comment so they state the membership rule as current fact: the identity map decides which accounts exist, the cache supplies their numbers, and the rotation array is still not read.
3. In `broker/usage/cache.test.ts`, write the regression test first and watch it fail before the change: the cache holds accounts 1, 2 and 3, the identity map holds 1 and 3, and the reading lists 1 and 3 in that order with account 2 absent. Add a second test pinning the fallback: the cache holds 1 and 2, `sequence.json` is absent, and the reading lists both with null identity. Leave the existing ordering test as it stands, since its identity map and cache carry the same three accounts.
4. Run the targeted lane, `node --test broker/usage/cache.test.ts`, then the whole gate, `npm test`, both from the repository root, and read each result from its exit code.

### Section 2: land it on the running broker

Model: inline. The broker runs from this checkout as the scheduled task named in `docs/operations.md`, so the change takes effect only after the checkout carries the merged commit and the broker restarts. After the PR merges, run `install/Repair-Broker.ps1 -Pull` from the repository root, then read the fleet card in Discord and confirm accounts 2 and 3 are gone and the six live accounts remain. Record the observation in the Chapter, since a green suite cannot see a card.

## Gate

- Baseline: the worker records `npm test` pass and fail counts and the exit code on a clean tree at the base commit before touching anything, and reports every later run as a delta against it.
- Section 1 closes on the targeted lane green, the whole gate green, and the red-then-green record for the new regression test in the Chapter.
- Section 2 closes on the operator's or the worker's own read of the rendered card, named in the Chapter as an observation rather than a suite result.
- The fresh-context reviewer pair runs over Section 1's delta before it is posted, per the executing-work skill.

## Out of Scope

- Changing claude-swap. Its cache pruning is its own; no source for it lives on this machine, and the broker's rule is to mirror its state rather than manage it.
- Pruning `cache/usage.json` from the broker. The reader is read-only over claude-swap's files by design, and that guarantee is worth more than a tidy cache.
- Any change to the card's layout, labels, or the ordering of accounts.

## Operator Verification

After Section 2, open the fleet card in Discord. The two retired accounts should be absent and the six remaining accounts should render as before, with the active marker on the current account.

## Chapters

### Chapter 1 - Section 1: filter the reading by the identity map - 2026-09-20

**What shipped.** `broker/usage/cache.ts` now takes account membership from `sequence.json`'s
`accounts` identity map. An account the cache still remembers but the map no longer lists does not
render. `accountEntries` gained an `isMember` predicate and applies it inside the cap loop, so a
retired account is dropped before it can spend a `MAX_USAGE_ACCOUNTS` slot and the cap counts
survivors, as the section required. The module header, the `accountEntries` doc and the `readUsage`
doc state the membership rule as current fact, and all three keep the standing sentence that the
`sequence` rotation array is not read.

**Red then green.** The regression test was written first and watched fail before `cache.ts` was
touched. Its failure was `actual: [ 1, 2, 3 ]` against `expected: [ 1, 3 ]` on
"an account absent from the identity map does not render, however long the cache remembers it".
That red is reported from the implementer's own run and quoted in its report; the mechanism is
confirmed independently by reading the pre-change `accountEntries`, which carried no membership
test at all, so all three accounts necessarily rendered.

**A pre-existing test had to be repaired, which the section did not anticipate.** "wrong-shaped
fields contribute nothing and the account count is capped" built an identity map holding only
account 9 while the cache held twenty-two, then asserted the cap yielded `MAX_USAGE_ACCOUNTS`.
Under the membership rule only account 9 survived and the assertion failed. The fixture was widened
so the map lists every numeric account the cache holds, which restores the cap rather than the
filter as the thing under test. No assertion was weakened. The non-numeric key stays excluded by the
key round-trip rule, which membership does not touch.

**Review findings addressed.** The fresh-context pair ran over the delta, both read-only, neither
permitted to run a suite. Adversarial returned APPROVED_WITH_CONCERNS with four Minors; blind
returned APPROVED_WITH_CONCERNS with one Major and three Minors. Both independently confirmed the
cap-counts-survivors ordering and the unreadable-file fallback are correct.

Accepted and fixed: `key in identities` became `Object.hasOwn(identities, key)`, matching the three
sibling sites at `broker/intake.ts:671`, `broker/tail.ts:1742` and
`broker/discord/question-message.ts:917`, each of which carries the same comment and a test pinning
the inherited-key case. The old form was not reachable, since the key filter upstream admits digits
only, but the guard making it safe lives in another function. A test title reading "exactly as
today" was rewritten as present fact per the house rule against change-narrative. Two branches the
pair found unpinned gained tests: an identity file that parses with no `accounts` map at all, and an
identity map that reads cleanly and holds none.

**Declined, and raised instead.** Blind rated a Major on the case where `sequence.json` parses with
an empty identity map: every cached account is filtered out and the card renders an empty fleet. The
behavior is left as the section specifies it. The section's Goal is parity with what `cswap watch`
shows, and an empty identity map is claude-swap stating it holds no accounts, so rendering none is
parity rather than loss. The section's first scoping decision also directs a worker who finds an
edge case around this rule to raise it rather than widen the rule. The consequence is now documented
in the `readUsage` doc and pinned by a test, and it is carried to the operator in this round's
close-out rather than decided here.

**Gate.** Every exit code read from its own run rather than from a grep over output. Baseline,
captured on a clean tree at the base commit `93f2c6d` before anything was touched: `npm test` exit 0,
tests 1717, pass 1716, fail 0, skipped 1. At this close: `npm run lint` exit 0; targeted lane
`node --test broker/usage/cache.test.ts` exit 0 at 24 tests, 24 pass, 0 fail; whole gate `npm test`
exit 0 at tests 1721, pass 1720, fail 0, skipped 1. The delta is plus four tests and plus four
passes, which is exactly the four tests this section added, with no other count moved. The machine's
heavy-process slot was claimed for the duration of these runs and released after them.

**Next:** 2. Land it on the running broker. That section cannot start until this branch's pull
request merges, and it then restarts the live broker, which is the operator's call rather than this
session's.

**Commit Model:** Branch-and-PR. Work on branch `retired-account-suppression`, push to `origin`,
open a PR against `main`, never push directly to `main`.
