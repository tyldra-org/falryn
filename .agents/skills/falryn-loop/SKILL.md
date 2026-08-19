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

Canonical contract: `falryn-docs/DEVELOPMENT.md` (Deliver, Next, merge, Project choreography). Load `git-workflow` for git mutations and `gh-cli` for GitHub PRs and checks. The contract wins on conflict.

**Sync.** Edit `~/.agents/skills/falryn-loop/SKILL.md`, then copy it to `falryn/.agents/skills/falryn-loop/SKILL.md`.

## Single controller

One controller owns the target and delivery bundle. Run readiness, implementation, and verification serially in the same agent. Do not create planner, implementer, verifier, or goal-wrapper subagents for a Deliver run.

Host-imposed async forking of this same controller (Cursor Multitask) is allowed if phases stay serial and there is still only one writer on the issue checkout. It does not authorize parallel Deliver phases or phase specialists.

On a Verify gap: return to Implementation, then a new Verification against the changed head. Manual Plan / Implement / Verify / Merge remain separate workflows.

## Deliver — Issue #N

Continue only for a standalone PR-sized issue or native child, including standalone milestone defects with no parent.

1. **Readiness.** Hierarchy, contracts, blockers, docs impact, split need. Close any earlier open delivery PR on the same parent chain before implementing this target. No code. Plan only if unresolved. Split into ordered native children only when boundaries are unambiguous. Otherwise `awaiting-input` with one question.
2. **Implementation.** Sole writer on the valid branch/PR bundle, or create the normal issue-linked branch and companions.
3. **Verification.** Full bundle: acceptance, required checks, docs, merge readiness. Read-only. Mid-Verify polish pushes invalidate the prior Verify. Re-Verify exact `headRefOid`s before merge.
4. **Repair.** Keep an open valid PR. Fresh branch after a merged incomplete outcome. Focused follow-up for a distinct outcome. After 3 repair passes without a progress signal (changed source, diagnostic, dependency, or validation), ask.
5. **Merge.** Authorized by this Deliver. Docs companions first, application last. Squash only. Final subject is the reviewed PR title. No body by default. At most one `Closes #N` / `Refs …` footer. Re-read heads, required checks, reviews, mergeability, method, and companion order immediately before each merge. Stop on any changed or failed precondition.
6. **Reconcile.** Issue and Project status, docs truth, `CURRENT-STATE.md` Planning frontier when the live frontier changed. Fast-forward both local mains when clean and safe. Then Next (standalone) or parent-chain continuation (native child). Do not jump to an unrelated Project item before the parent chain is reconciled.

A child's cycle is complete only after docs-first merge, application merge, and issue/Project reconcile. Opening PRs or starting CI is not a completed cycle and is not a reason to emit a next prompt.

## Deliver — Parent issue #N

Never a parent branch or mega-PR. Select the first ordered unblocked incomplete child. Run that child's full cycle. Stop if siblings remain:

```text
Suggested next prompt: Deliver — Target: Issue #<exact child>
```

Do not emit that sibling prompt while the current child's CI, merge, or reconcile is still unfinished. Resume the same `Parent issue #N` until that child has landed.

Last required child: run the parent's integrated verification in-loop. Close the parent only when it passes. Otherwise one integration child and its Deliver prompt. After a passing parent, run Next and report. Do not start the next parent or standalone in the same run.

## Deliver — Parent chain #N

Same scheduler as Parent issue, different stop. After each child's complete cycle, continue to the next ordered unblocked incomplete sibling in this run. Still one child, one delivery PR (plus companions), serial. Never a parent branch or mega-PR.

Do not emit `Deliver — Target: Issue #<next sibling>` during an in-flight chain. That form is the Parent-issue one-child stop, not a chain continuation.

Stop the chain on awaiting-input, a failed merge precondition, or three repair passes without progress. Report the exact child plus `Deliver — Target: Issue #<child>`. CI wait is none of those stops.

If the host ends the turn during CI or merge, report the PR(s) and head SHA(s) and resume the same chain:

```text
Suggested next prompt: Deliver — Target: Parent chain #<same parent>
```

Last required child: parent's integrated verification in-loop, same as Parent issue. After a passing parent, run Next and report. Do not start the next unrelated parent or standalone. Next never auto-emits `Parent chain`. That selector is user-initiated. `Docs parent chain #N` is the same loop on `falryn-docs`.

## Required vs advisory checks

Merge gates are the repository ruleset required status checks, and required review-thread rules. Advisory jobs (Benchmark regression when not in the ruleset) must not block Deliver merge unless the issue acceptance criteria or `DEVELOPMENT.md` explicitly require them. Failed or missing required checks always block.

## CI and long waits

Background `gh run watch`. Do not foreground-poll. That wait is not a Deliver stop, not a completed child, and not permission to emit Next or a next-sibling prompt.

Keep useful in-scope work going (the other companion PR, local parent-seam tests, merge-precondition notes). If the host ends the turn, report the PR(s) and head SHA(s) and resume the **same** Deliver target. When the watcher completes, re-read merge preconditions and continue merge → reconcile → chain continuation. Procedure lives in `gh-cli` → [ci.md](../gh-cli/process/ci.md).

## Next routing

Read Project, issue graph, blockers, open bundles, review/check state, and `CURRENT-STATE.md`. Board position, creation-order visuals, and recent updates are not priority.

1. Validated Planning frontier plus `DEVELOPMENT.md` next-prompt table. Resolve target and state only. Do not echo manual Plan/Implement/Verify/Merge in autonomous reports. If the frontier conflicts with live GitHub, name the mismatch and follow live state.
2. Resume that bundle or parent chain when implementation, CI, merge, or reconcile is still unfinished. An in-flight delivery PR is the current target, not leftover to skip. Unrelated In Progress items do not outrank the frontier.
3. Else: Priority P0→P3 when set, then earliest eligible native child or root by stable issue creation order.
4. Emit `Deliver — Target: Issue #N` or `Deliver — Target: Parent issue #N` for every eligible Falryn issue or parent. Todo/Ready/mid-delivery is not a reason to emit a manual mode. Do not auto-emit `Parent chain`.
5. Manual prompt only outside Deliver coverage (docs-only, PR/milestone audit, authorized release). Blocked by product or external prerequisite → `Suggested next prompt: none`.

After a completed parent or standalone, same procedure. Do not resume the just-completed target.

## Awaiting input and reports

Ask only for an unresolved product choice, conflicting or missing contract, unclear split, external dependency, or exhausted repair budget. Resume from the blocked stage. Never restart from guessed state.

Deliver / Next suggest only:

```text
Suggested next prompt: Deliver — Target: Issue #<exact issue>
Suggested next prompt: Deliver — Target: Parent issue #<exact parent>
Suggested next prompt: Deliver — Target: Parent chain #<exact parent>
Suggested next prompt: none
```

`Parent chain` is resume-only for an in-flight chain (host-ended CI/merge). Next never emits it. `none` names the exact prerequisite. Next includes the observed active or blocked state that led to the choice.
