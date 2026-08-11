---
name: falryn-delivery-loop
description: "Drive one Falryn standalone issue or native child issue through a single-agent planning, implementation, verification, authorized automatic delivery, and parent-reconciliation loop. Also route the next Falryn delivery target from the canonical planning frontier and resume state. Use when the user says Deliver — Target: ..., Next — Target: Falryn Roadmap, asks what to implement next, or asks to run a complete delivery cycle."
---

# Falryn Delivery Loop

Follow this skill only after reading the applicable global and repository
guidance, `falryn-docs/DEVELOPMENT.md`, and the required GitHub workflow
guidance. The canonical delivery contract wins if this skill conflicts with it.

## Single-controller loop

Use the root agent as the single controller. Do not create planner,
implementer, verifier, or goal-wrapper agents for a `Deliver` run.
The controller retains the target and delivery-bundle context, resolves the
exact Falryn target before every state-changing stage, and records the current
loop generation.

Run these phases serially in the same agent:

1. **Readiness** — inspect issue hierarchy, contracts, blockers, documentation
   impact, and whether the issue must split. Do not write code.
2. **Implementation** — be the sole writer for the selected issue's branch,
   tests, docs companion, commits, and pull requests.
3. **Verification** — inspect the complete delivery bundle for acceptance,
   checks, documentation, and merge readiness. Do not edit during this phase.

Do not overlap phases or run concurrent writers against one checkout or issue
branch. On a verification gap, return explicitly to Implementation, then run a
new Verification phase against the changed head. The manual Plan, Implement,
Verify, and explicit Merge prompts remain separate workflows.

## Standalone or child issue

For `Deliver — Target: Issue #N`:

1. Resolve the issue as Falryn and classify it. Continue only for a standalone
   PR-sized issue or native child.
2. Run planning only when readiness is unresolved. Split into ordered native
   children when the existing contract makes the boundaries unambiguous;
   otherwise enter `awaiting-input` with one focused question.
3. Run implementation on the valid existing delivery branch and pull request,
   or create the normal issue-linked branch and delivery bundle.
4. Run a fresh Verification phase.
5. For an observed gap, use the correction rules in `DEVELOPMENT.md`: keep an
   open valid PR, use a fresh branch after a merged PR, and create a focused
   follow-up for a distinct outcome. Verify again after every changed head.
6. Allow at most three repair passes without a new progress signal. A changed
   source generation, diagnostic, dependency state, or validation result is a
   progress signal; repeating an equivalent failure is not.
7. A `Deliver` prompt authorizes the reviewed docs-first/application-last
   squash merge after a fresh passing verification. Re-read exact heads,
   checks, reviews, mergeability, merge method, and companion order immediately
   before each merge. Stop on any changed or failed precondition.
8. Reconcile the merged issue, Project status, documentation truth, and safe
   local-checkout synchronization. After a completed standalone issue, run the
   Next routing procedure. After a directly delivered native child, reconcile
   its parent chain first: deliver its next eligible sibling, or run the
   parent's integrated verification when it was the last required child. Do not
   jump to an unrelated Project item before that parent chain is reconciled.

## Parent target

For `Deliver — Target: Parent issue #N`, never create a parent branch or
parent pull request. Resolve its ordered required children, select the first
unblocked incomplete child, and run that child's complete cycle.

After that child completes, stop when another child remains and report only:

```text
Suggested next prompt: Deliver — Target: Issue #<exact child>
```

When the completed child was the last required child, run the parent's
integrated verification in the same loop. Close and reconcile the parent only
when it passes. If it needs product integration, create one explicit
integration child and report that child's `Deliver` prompt. After a parent
passes, run the Next routing procedure and report its result; do not begin the
next parent or standalone issue in the same delivery run.

## Next routing and resume state

For `Next — Target: Falryn Roadmap` or “what should I implement next?”, read
the Project, issue hierarchy, blockers, open delivery bundles, reviews/checks,
and `CURRENT-STATE.md`. Project item position, creation position, and recent
updates are not priority signals: new intake work often appears at the bottom
of a view and must not displace the real delivery frontier.

Route one exact next target in this order:

1. Start with the validated **Planning frontier** in `CURRENT-STATE.md` and
   its exact canonical transition in `DEVELOPMENT.md`'s “Suggesting the next
   prompt” table. Use that manual transition only to resolve the target and
   state; do not echo its manual mode in an autonomous report. If the written
   frontier conflicts with live GitHub state, explain the mismatch and follow
   the live transition; never silently select by board position.
2. Resume the delivery bundle or parent chain selected by that transition.
   Name whether it is at planning, implementation, verification, automatic
   merge preconditions, or awaiting input. An unrelated **In Progress** board
   item does not outrank the frontier merely because it was updated recently.
3. If no validated frontier or continuation exists, resolve the unblocked
   dependency and parent-child graph. Prefer a populated Project `Priority`
   field in P0-to-P3 order, then the earliest eligible native child or root
   outcome by its stable issue creation order. Use the Project's visual order
   only for display, never for scheduling.
4. For an eligible Falryn parent, emit `Deliver — Target: Parent issue #N`;
   Deliver selects its first eligible child. For an eligible standalone or
   native child, emit `Deliver — Target: Issue #N`. A Todo, Ready, planning,
   implementation, verification, or merge state is not a reason to emit a
   manual prompt: Deliver owns those phases.
5. Emit a manual prompt only when the selected work is outside Deliver's
   coverage, such as a docs-only issue or pull request, a pull-request or
   milestone audit, or a separately authorized release action. If an eligible
   delivery is blocked by a product choice or external prerequisite, emit
   `Suggested next prompt: none` rather than falling back to a manual mode.

After a completed parent or standalone issue, apply the same procedure but do
not resume the just-completed target. Its report therefore names the precise
next eligible parent or standalone issue, or `none` when the Roadmap has no
eligible work.

## Awaiting input and reporting

Ask the user only for an unresolved product choice, conflicting or missing
contract, unclear split boundary, external dependency, or exhausted repair
budget. Preserve the loop state and resume from the blocked stage after an
answer; never restart from an assumed fresh target.

For a `Deliver` report, suggest only `Deliver — Target: Issue #N`, `Deliver —
Target: Parent issue #N`, or `Suggested next prompt: none` with the exact
prerequisite. Next uses the same three forms for every eligible Falryn issue or
parent and includes the current delivery or blocked state that led to its
choice. Next may suggest an exact manual prompt only for work outside Deliver's
coverage. Manual Plan, Implement, Verify, and Merge prompts retain their own
transition table only after the user explicitly selects a manual workflow.
