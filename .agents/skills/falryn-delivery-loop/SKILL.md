---
name: falryn-delivery-loop
description: "Drive one Falryn standalone issue or native child through a single-controller Deliver loop (readiness → implement → verify → authorized docs-first merge → reconcile → Next). Also route Next from the Planning frontier. Use for Deliver — Target: ..., Next — Target: Falryn Roadmap, “what next?”, or a complete delivery cycle. Maintainer delivery modes only."
---

# Falryn Delivery Loop

**Maintainer-optional.** Load for `Deliver` / `Next` (or “what should I implement next?”). Do not impose this loop on ordinary contributor PRs or casual checkouts. Canonical contract: `falryn-docs/DEVELOPMENT.md` (Deliver / Next / merge / Project choreography). Also load `git-workflow` for git mutations and `gh-cli` for GitHub PRs/checks. Contract wins on conflict.

**Sync:** Edit `~/.agents/skills/falryn-delivery-loop/SKILL.md`, then copy identically to `falryn/.agents/skills/falryn-delivery-loop/SKILL.md`.

## Single controller

One controller owns the target and delivery bundle. Run readiness → implementation → verification **serially** in the same agent. Do **not** create planner / implementer / verifier / goal-wrapper subagents for a Deliver run.

Host-imposed async forking of **this same controller** (e.g. Cursor Multitask) is allowed if phases stay serial and there is still only one writer on the issue checkout. It is not a license to parallelize Deliver phases or spawn phase specialists.

On a Verify gap: return to Implementation, then a **new** Verification against the changed head. Manual Plan / Implement / Verify / Merge remain separate workflows.

## Deliver — Issue #N

Continue only for a standalone PR-sized issue or native child (including standalone milestone defects with no parent).

1. **Readiness** — hierarchy, contracts, blockers, docs impact, split need. Close any earlier open delivery PR on the same parent chain before implementing this target. No code. Plan only if unresolved; split into ordered native children only when boundaries are unambiguous; else `awaiting-input` with one question.
2. **Implementation** — sole writer on the valid branch/PR bundle, or create the normal issue-linked branch + companions.
3. **Verification** — full bundle: acceptance, **required** checks, docs, merge readiness. Read-only. Mid-Verify polish pushes invalidate the prior Verify; re-Verify exact `headRefOid`s before merge.
4. **Repair** — keep open valid PR; fresh branch after merged incomplete outcome; focused follow-up for a distinct outcome. ≤3 repair passes without a progress signal (changed source, diagnostic, dependency, or validation), then ask.
5. **Merge** (authorized by this Deliver) — docs companions first, application last. Squash only; final subject = reviewed PR title; **no body** by default (at most one `Closes #N` / `Refs …` footer). Re-read heads, **required** checks, reviews, mergeability, method, companion order immediately before each merge; stop on any changed or failed precondition.
6. **Reconcile** — issue + Project status, docs truth, **`CURRENT-STATE.md` Planning frontier** when the live frontier changed, FF both local mains when clean/safe. Then Next (standalone) or parent-chain continuation (native child). Do not jump to an unrelated Project item before the parent chain is reconciled.

## Deliver — Parent issue #N

Never a parent branch or mega-PR. Select the first ordered unblocked incomplete child; run that child's full cycle; stop if siblings remain:

```text
Suggested next prompt: Deliver — Target: Issue #<exact child>
```

Last required child → parent's integrated verification in-loop; close parent only when it passes; else one integration child + its Deliver prompt. After a passing parent, run Next and report; do not start the next parent/standalone in the same run.

## Deliver — Parent chain #N

Same scheduler as Parent issue, different stop. After each child's complete cycle, continue to the next ordered unblocked incomplete sibling in this run. Still one child, one delivery PR (plus companions), serial; never a parent branch or mega-PR.

Stop the chain on awaiting-input, a failed merge precondition, or three repair passes without progress. Report the exact child plus the matching resume prompt (`Deliver — Target: Issue #<child>`).

Last required child → parent's integrated verification in-loop, same as Parent issue. After a passing parent, run Next and report; do not start the next unrelated parent/standalone. Next never auto-emits `Parent chain`; that selector is user-initiated. `Docs parent chain #N` is the same loop on `falryn-docs`.

## Required vs advisory checks

Merge gates are the repository **ruleset required status checks** (and required review-thread rules). Advisory / non-required jobs (e.g. Benchmark regression when not in the ruleset) **must not** block Deliver merge unless the issue acceptance criteria or `DEVELOPMENT.md` explicitly require them. Failed or missing **required** checks always block.

## CI and long waits

While waiting for **required** checks between Verification and Merge (and for
post-merge frontier reconcile PRs), run the wait/poll **in the background by
default**. Do not hold the turn on multi-minute foreground sleeps. Report the
PR(s) and head SHA(s) being watched, then continue other work or end the turn.
When the watcher completes, re-read merge preconditions immediately before each
authorized squash-merge. Procedure lives in `gh-cli` →
[ci.md](../gh-cli/process/ci.md) (background watch default).

## Next routing

Read Project, issue graph, blockers, open bundles, review/check state, and `CURRENT-STATE.md`. Board position, creation order visuals, and recent updates are not priority.

1. Validated **Planning frontier** + `DEVELOPMENT.md` next-prompt table → resolve target/state only; do not echo manual Plan/Implement/Verify/Merge in autonomous reports. If frontier conflicts with live GitHub, name the mismatch and follow live state.
2. Resume that bundle/parent chain when implementation is still incomplete. A pushed PR waiting only on CI, merge, or reconcile is leftover work, not the Next target. Name it in the report and pick the next frontier item. Unrelated **In Progress** items do not outrank the frontier.
3. Else: Priority P0→P3 when set, then earliest eligible native child or root by stable issue creation order.
4. Emit `Deliver — Target: Issue #N` or `Deliver — Target: Parent issue #N` for every eligible Falryn issue/parent. Todo/Ready/mid-delivery is not a reason to emit a manual mode. Do not auto-emit `Parent chain`; that selector is user-initiated.
5. Manual prompt only outside Deliver coverage (docs-only, PR/milestone audit, authorized release). Blocked by product/external prerequisite → `Suggested next prompt: none`.

After a completed parent or standalone, same procedure but do not resume the just-completed target.

## Awaiting input and reports

Ask only for unresolved product choice, conflicting/missing contract, unclear split, external dependency, or exhausted repair budget. Resume from the blocked stage; never restart from guessed state.

Deliver / Next suggest only:

```text
Suggested next prompt: Deliver — Target: Issue #<exact issue>
Suggested next prompt: Deliver — Target: Parent issue #<exact parent>
Suggested next prompt: none
```

`none` names the exact prerequisite. Next includes the observed active/blocked state that led to the choice.
