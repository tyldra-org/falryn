---
name: falryn-loop
description: >-
  Ship one Falryn standalone issue or native child: readiness, implement,
  verify, authorized docs-first merge, reconcile, Next. Also route Next from
  the Planning frontier. Use for Deliver — Target: ..., Next — Target: Falryn
  Roadmap, "what next?", or a full delivery cycle. Maintainer delivery modes
  only.
---

# Falryn loop

Maintainer-optional. Load for `Deliver` / `Next`, or "what should I implement next?" Do not impose this on ordinary contributor PRs.

Canonical contract: `falryn-docs/DEVELOPMENT.md` (Deliver, Next, merge, Project choreography). Load **git-workflow** for git mutations and **gh-cli** for GitHub PRs, Projects, and checks. The contract wins on conflict.

Generic GitHub lifecycle (assign, **In Progress** / **Done**, post-merge reconcile, serial vs single-child patterns): **gh-cli** → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md). Local default-branch sync after merge: **git-workflow** → [delivery-checkout.md](../git-workflow/reference/delivery-checkout.md).

**Distribution.** The copy under `falryn/.agents/skills/falryn-loop/` is what contributors receive — commit skill changes here. Maintainers who also keep `~/.agents/skills/falryn-loop/` can sync with `.agents/skills/sync-from-global.sh` (reverse: copy repo → global after editing in-repo).

## Single controller

One controller owns the target and delivery bundle. Run readiness, implementation, and verification serially in the same agent. Do not create planner, implementer, verifier, or goal-wrapper subagents for a Deliver run.

Host-imposed async forking of this same controller (Cursor Multitask) is allowed if phases stay serial and there is still only one writer on the issue checkout. It does not authorize parallel Deliver phases or phase specialists.

On a Verify gap: return to Implementation, then a new Verification against the changed head. Manual Plan / Implement / Verify / Merge remain separate workflows.

## Falryn Deliver selectors

| Selector | Scope per run | When the run may end |
| --- | --- | --- |
| `Deliver — Target: Issue #N` | One issue | After that issue's full cycle + reconcile |
| `Deliver — Target: Parent issue #N` | **First** eligible native child only | After one child lands; emit `Deliver — Target: Issue #<next sibling>` |
| `Deliver — Target: Parent chain #N` | **Every** remaining native child, serial | After **all** children + parent integrated verification, or a real stop (below) |

Maps to generic patterns in **gh-cli** → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md): **single-child handoff** vs **serial chain**.

**Common mistake:** treating `Parent chain` like `Parent issue` — merging one child, writing a status report, and stopping.

## Child cycle (every Falryn Deliver target)

1. **Readiness.** Hierarchy, contracts, blockers, docs impact (`DOCUMENTATION-MAP.md`), split need. Close any earlier open delivery PR on the same parent chain before implementing this target. No code. Plan only if unresolved. Split into ordered native children only when boundaries are unambiguous. Otherwise `awaiting-input` with one question.
2. **Implement start (before first commit).** **gh-cli** → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md#work-start-before-the-first-commit). Falryn Roadmap Project (`tyldra-org`, project `1`). Assign owner; **In Progress** on the target; parent **In Progress** when first active child.
3. **Implementation.** Sole writer on `feat|fix|docs|refactor|test|chore/<issue>-purpose` from current default. Companion docs PR when canonical docs change (`falryn-docs`, `Refs tyldra-org/falryn#<issue>`).
4. **Verification.** `bun run check`; packaging changes also `bun run build`. Read-only audit of acceptance, required checks, docs, merge readiness. Re-Verify exact `headRefOid`s before merge.
5. **Repair.** Keep an open valid PR. Fresh branch after merged incomplete outcome. After 3 repair passes without progress, ask.
6. **Merge.** Authorized by this Deliver. **gh-cli** → [delivery.md](../gh-cli/process/delivery.md): docs companions first, Falryn application last. Squash; subject-only merge commit; at most one `Closes #N` / `Refs …` footer on the app PR.
7. **Reconcile (mandatory; merge is not enough).** **gh-cli** → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md#work-landed-after-merge) for closed child **Done**, parent **In Progress**, next sibling **In Progress**. Update `falryn/CURRENT-STATE.md` when the planning frontier changed. **git-workflow** → [delivery-checkout.md](../git-workflow/reference/delivery-checkout.md) for `falryn` and `falryn-docs` checkouts.
8. **Continue or finish.** Standalone → Next. Parent issue → stop with next-child prompt. Parent chain → **immediately** start the next sibling's step 1 in the **same run**.

A child's cycle is complete only after docs-first merge, application merge, **and** GitHub/Project reconcile. Green CI or a closed issue alone is **not** completion.

## Deliver — Issue #N

One Ready, unblocked PR-sized issue or native child. Follow [Child cycle](#child-cycle-every-falryn-deliver-target). After step 8, run Next.

## Deliver — Parent issue #N

Never a parent branch or mega-PR. First ordered unblocked incomplete native child only. Full [Child cycle](#child-cycle-every-falryn-deliver-target). **Stop** if siblings remain:

```text
Suggested next prompt: Deliver — Target: Issue #<exact next sibling>
```

Last child: parent integrated verification in-loop; close parent only when it passes. Then Next.

## Deliver — Parent chain #N

Every remaining native child, serial. Same [Child cycle](#child-cycle-every-falryn-deliver-target) per child. After step 7, **continue in the same run** — generic **serial chain** rules in **gh-cli** → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md#single-slice-vs-serial-multi-child-delivery).

### Falryn-specific forbidden stops

Do **not** end the turn after merge, opened PR, CI start, or a status report while **#264-style** siblings remain and the host did not cut the turn.

Do **not** emit `Deliver — Target: Issue #<next sibling>` mid-chain (Parent-issue handoff form).

`Suggested next prompt: Deliver — Target: Parent chain #N` is **only** for host-ended CI/merge/reconcile mid-child.

### Chain progress (include in reports)

```text
Parent chain #264: #265 Done → #266 in progress → #267–#270 pending
```

Last child: parent integrated verification; close parent when it passes. Then Next. Next never auto-emits `Parent chain`. `Docs parent chain #N` is the same loop on `falryn-docs`.

## AGENTS.md report rule

`AGENTS.md` asks for `Suggested next prompt` at end of Deliver reports. That applies when the run **actually ends** (standalone, Parent issue after one child, completed Parent chain, or real stop / host cut).

While `Parent chain #N` has incomplete siblings and the host has not cut the turn, **do not** end with a resume prompt — **continue the next child**.

## Required vs advisory checks

Merge gates: repository ruleset **required** status checks and required review-thread rules. Advisory jobs (e.g. Benchmark regression when not required) do not block unless issue acceptance or `DEVELOPMENT.md` says so.

## CI and long waits

**Parent chain and Deliver:** CI is **not** a stop. Do **not** end the turn, write a status report, or emit a resume prompt while required checks are still running and the host has not cut the turn.

**Prefer foreground wait** in Deliver runs. Background `gh run watch` does not reliably resume the same agent turn when it finishes — if the host does not ping back, **run `gh run watch` in the foreground** and stay in the Deliver until green, failure, or a fix loop.

```bash
gh run watch RUN_ID --repo tyldra-org/falryn --exit-status
```

After green: re-read PR head SHA and required checks, then merge in the **same run** per step 6. Only use background watch when the host explicitly ends the turn; then report PR URL(s), head SHA(s), and [chain progress](#chain-progress-include-in-reports).

Details: **gh-cli** → [ci.md](../gh-cli/process/ci.md#deliver-and-serial-chain-runs).

## Next routing

Read Falryn Roadmap Project, issue graph, blockers, open bundles, checks, and `falryn/CURRENT-STATE.md`. Frontier conflicts → follow live GitHub and name the mismatch.

1. Validated Planning frontier + `DEVELOPMENT.md` next-prompt table.
2. Resume in-flight bundle or parent chain before unrelated items.
3. Else P0→P3, then earliest eligible native child/root by creation order.
4. Emit `Deliver — Target: Issue #N` or `Deliver — Target: Parent issue #N`. Do not auto-emit `Parent chain`.
5. Blocked → `Suggested next prompt: none` with the prerequisite named.

## Awaiting input and reports

Ask only for unresolved product choice, conflicting contract, unclear split, external dependency, or exhausted repair budget.

Deliver / Next suggest only:

```text
Suggested next prompt: Deliver — Target: Issue #<exact issue>
Suggested next prompt: Deliver — Target: Parent issue #<exact parent>
Suggested next prompt: Deliver — Target: Parent chain #<exact parent>
Suggested next prompt: none
```

`Parent chain` in suggestions is resume-only (host-ended mid-chain). Next never emits it.
