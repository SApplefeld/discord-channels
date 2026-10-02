# The relay publishes its runtime tree to the public marketplace repository on a tag, with the plugin shim two levels in and no version

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 as the relay repository's instance of the public distribution design the kit repository's `claude-kit_public-marketplace_spec_v1.md` carries, on the operator's decisions of 2026-09-28 and his rulings of 2026-10-02. It has no precondition, since the relay keeps its name. Section 1's scripts, tests and workflow wait on the kit plan's section 1 merging, since they are copies of it. The coordinator queues it for this repository's worker at once. The first publish waits on the kit's job seeding the public repository, under the kit plan's steps. While this repository is public, no commit, pull request, Chapter or brief on this plan spells any word on the banned list or the path of a file that leaks one.

## Goal

This repository carries a GitHub Actions workflow that runs on a pushed tag matching `publish-*` and on a manual run, assembles a root-layout snapshot of the relay's runtime from a committed allowlist, strips the `version` from the plugin manifest so installs follow commits, fails on any forbidden path and on any word from the list held as a repository secret, and pushes one commit replacing `plugins/relay/` in `SApplefeld/plugins` over the deploy key. The public marketplace's entry points at `./plugins/relay/plugins/relay`, the shim, and a client host installs the broker from the same folder's `install/` scripts with `docs/install.md` beside them. The README says how a release is cut.

## Intent

The frame, in the operator's words of 2026-10-01: "a singular plugin that was installable for the full functionality of personas, plus Discord channels, plus what is currently named Claude Kit (but without any of the documentation, docs, plans, backlog, or history, just the core functionality of the plugin in a singular public repo with three entries that is all installable from one place)."

What done needs to do. The job, from the kit's design, with this repository's allowlist. The relay's installed plugin is a shim: `plugins/relay/launch.mjs` runs the broker named in a registration the launch wrapper writes from a live checkout, so the plugin alone serves nothing, and the full functionality the operator asked for is the broker, the bridge, the hooks, the wrapper and the install scripts. The snapshot keeps the repository's root layout so those scripts' relative paths hold, carries `docs/install.md` as the one document, since a host cannot be installed without it, and the entry's source names the shim two levels in. The manifest's `version` is stripped in the snapshot, per the 2026-09-28 decision, and left in the repository.

What done does not need to do. It does not change how the shim finds the broker. It does not publish the tests, the tools, the fixtures or any other document. It does not change the private marketplace file.

Alternatives refused. Publishing the shim alone: refused, since an installer would have a channel that fails at launch with no broker to point at. Hoisting the shim to the folder's root and the runtime beside it: refused, since every install script resolves paths from the repository root and the snapshot would need a second layout the tests do not cover. Stripping `version` in the repository: refused, since the private marketplace's install on a developer's machine keeps its pin.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02, with the shim's behavior read from `plugins/relay/launch.mjs` at a2af535.

## Approach

**The job and the scripts.** `tools/publish/assemble.mjs` and `tools/publish/leak-gate.mjs` are the kit plan's two scripts, copied byte for byte from the kit repository's `tools/publish/` at the commit its plan landed, with a header line naming that origin. `tools/publish/allowlist.txt` is: `plugins/relay/**`, `broker/**`, `bridge/**`, `relay/**`, `hooks/**`, `install/**`, `wrapper/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `docs/install.md`. The assembler's forbidden set keeps out every `.test.` file those globs would otherwise carry, 57 of the 118 files under `broker/` among them, and `tools/`, so the allowlist can name whole directories. The one document named is the only path under `docs/` the set admits, by an explicit allow for that path in this repository's copy of the list, which the assembler honors as a literal path ahead of the set. The workflow runs the assembler with `--strip-version`, and the manifest at `plugins/relay/.claude-plugin/plugin.json` in the snapshot carries no `version`. `.github/workflows/publish.yml` is the kit's workflow with `relay` for the plugin, `plugins/relay` for the folder, `discord-channels` for the repository name in the commit title, and no seed step.

**The leak sweep, prerequisite (3).** The gate over the assembled snapshot, run locally with a temporary list the operator hands the worker on its thread, is the sweep the 2026-09-28 record asked for over the plugin folders. A hit is rewritten to a generic word before the section closes and recorded by path and line.

**The README.** `README.md` gains a release section: tag trunk `publish-<YYYYMMDD>` or any `publish-` tag, push it, read the run, what the job refuses, and that an installer's host setup is `docs/install.md` as it ships in the public folder.

**The tests.** `tools/publish/assemble.test.ts` and `tools/publish/leak-gate.test.ts` pin the kit plan's cases in this repository's test shape, and a third case pins the literal-path allow for `docs/install.md` admitting that file and refusing `docs/operations.md`.

## Sections of Work

### 1. The publish job, the allowlist with the host runtime, and the release section

Model: sonnet

Acceptance:
- `node tools/publish/assemble.mjs --allowlist tools/publish/allowlist.txt --out <tmp> --strip-version` on this checkout copies the files the allowlist resolves minus every `.test.` file, the count in the Chapter; `<tmp>/plugins/relay/.claude-plugin/plugin.json` carries no `version`; `<tmp>/docs/install.md` is present and no other path under `<tmp>/docs/` is.
- `cmp` of the two scripts against the kit's copies reads identical below the origin header line, recorded with the kit commit copied from.
- `npm test` is green against the baseline recorded before the section's first edit, with the three new cases, and the planted-word case red against a gate stub before the copy.
- `node tools/publish/leak-gate.mjs --root <tmp> --words-file <a temporary list from the operator>` passes over the assembled snapshot, the run in the Chapter with no word.
- `README.md` carries the release section.

Files in scope: `tools/publish/assemble.mjs`, `tools/publish/leak-gate.mjs`, `tools/publish/allowlist.txt`, `tools/publish/assemble.test.ts`, `tools/publish/leak-gate.test.ts`, `.github/workflows/publish.yml`, `README.md`, and any file the sweep rewrites.
Tests: the test-file exclusion over a directory glob, since the broker's tests carry fixture text an installer has no use for and the glob admits them by default; the literal-path allow under `docs/`, since it is the one hole in the forbidden set and must admit one file only.

## Out of Scope

- The public repository's catalog and README, which the kit's job seeds; the entry's source for the relay is written there.
- The private marketplace file and its `version`.
- How the installed shim finds the broker.

## Assumptions

- assumed 2026-10-02 (source: `plugins/relay/launch.mjs` and `install/*.ps1` at a2af535): the install scripts resolve paths from the repository root, so a root-layout snapshot installs as a checkout does; reversal: a script that reads a path above its root, which the worker finds at the first install and records as found work.
- assumed 2026-10-02 (default): the kit's assembler honors a literal path in the allowlist ahead of the forbidden set, which the kit plan's worker adds when this plan's need reaches it; reversal: the relay's copy of the assembler carrying that one difference, named in its header.
- assumed 2026-10-02 (default): the blind read and the plan review are skipped, since the design is the kit plan's and this spec is one section instancing it.

## Operator Verification

- The first publish and the clean-machine install, under the kit plan's steps. On the clean machine, after installing `relay@applefeld`, run the host install from the installed folder's `install/Install-All.ps1` per the shipped `docs/install.md` and read a session's channel attach. A failure at the shim or the install reopens this plan.

## Open Questions

- None.

## Related

- `claude-kit_public-marketplace_spec_v1.md` in the kit repository: the design this plan instances.

## Chapters

### Interim board 1 - 2026-10-02

Status header changed from `Ready` to `In Progress` on taking the plan. The coordinator queued it as goal node plan-muqqpqbe-js1e.

Section 1 is partly built. The two parts that depend on no kit artifact are on the branch: `tools/publish/allowlist.txt`, holding exactly the eleven lines the Approach names, and the `## Releases` section in `README.md`. Neither is reviewed yet. The section's one review round runs over the whole section once the scripts land.

Section 1 waits on the kit. Its two scripts and its workflow are copied byte for byte from the kit repository's `tools/publish/` and `.github/workflows/publish.yml`. At 2026-10-02, the kit's `plans/public-marketplace` branch (36c35c60, draft PR #178) holds only its spec. The kit plan has a dispatch precondition: its grimoire rename must merge first. The worker asked the architect (record ARCHITECT-ee5bff81-37a5-48ac-a352-f3fe0b58a437-1) whether to park or build ahead.

Ruling, the architect, 2026-10-02 (record DEV-DISCORD-57239bb8-86bf-43a8-85e2-365e2d444dbf-1): build the kit-independent parts now, then park. Writing the relay's own copies of the scripts is refused, because the `cmp` acceptance makes the kit's copy the source of truth. A second author would only buy a replace-and-recheck later, and the first publish waits on the kit's job seeding the public repository anyway.

Parked items, all inside section 1: `tools/publish/assemble.mjs`, `tools/publish/leak-gate.mjs`, `tools/publish/assemble.test.ts`, `tools/publish/leak-gate.test.ts`, `.github/workflows/publish.yml`, and the leak sweep over the assembled snapshot. Dependency: the kit's `plans/public-marketplace` plan merging its section 1 to the kit's main, which lands `tools/publish/` and `.github/workflows/publish.yml` there. Resume when those files exist on the kit's main.

Approval drift, on the architect's ruling above:
- The Dispatch Authorization gains the sentence "Section 1's scripts, tests and workflow wait on the kit plan's section 1 merging, since they are copies of it." It follows the no-precondition sentence, which stands for queueing.
- The Approach's "118 files under `broker/` among them" now reads "57 of the 118 files under `broker/` among them".

Evidence for the count, from `git ls-tree -r --name-only origin/plans/public-marketplace` at 7208800, tracked files per allowlist path: `plugins/relay` 3, `broker` 118 (57 carrying `.test.`), `bridge` 22, `relay` 10, `hooks` 5, `install` 11, `wrapper` 5, and `package.json`, `package-lock.json`, `tsconfig.json` and `docs/install.md` 1 each.

Operator inputs pending, asked on the worker's thread on 2026-10-02: a temporary banned-word list for the local leak sweep, and, before any publish, the public repository, the two secrets and Actions enabled.

Gate baseline: not yet recorded. It is taken before the scripts' first edit.

Next action: once the kit's scripts and workflow are on the kit's main, copy the scripts and workflow, record the `npm test` baseline, and write the tests.
