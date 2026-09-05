# Deliver

Deliver is one maintainer controller for one resolved PR-sized issue at a time. It serially performs readiness, implementation, fresh verification, bounded correction, merge, and reconciliation. It never creates planner, implementer, verifier, goal-wrapper, or parent-branch machinery.

## Authority

Upstream Deliver requires authenticated private Roadmap access because it changes Status and Readiness, resolves exact sequence and ownership, and reconciles completion through [governance audits](governance-audits.md). A required docs companion also requires private Falryn Docs access and [documentation delivery](documentation-delivery.md). Without either required authority, return `unavailable` before state mutation and name the explicit public preparation or maintainer action that can proceed.

The originating Deliver request authorizes merge only for the exact issue's freshly verified application PR and explicitly verified companions. It does not authorize changed revisions, missing checks, unresolved reviews, a different owner, or unrelated pull requests.

## Efficient execution

Apply [shared execution efficiency](execution-efficiency.md) throughout the existing controller loop. Deliver alone composes modes; evidence reuse never authorizes a manual mode to enter this loop. Keep bounded repairs, exact-revision verification, docs-first merge, and reconciliation unchanged.

## Controller loop

1. Resolve the exact public issue, private Project state, assignee, hierarchy, blockers, and current delivery work.
2. Plan only when readiness is unresolved, keeping the issue Todo.
3. Set In Progress immediately before implementation after all preconditions pass.
4. Implement one complete PR-sized slice and any required private companion.
5. Verify the exact bundle without source mutation.
6. Return actionable gaps to the same issue and branch, require observable progress, then verify the new revision.
7. After three repair passes without changed evidence, stop for a different strategy.
8. Merge private docs first and the application last under [Merge](merge.md).
9. Reconcile issue, private Project, parent, `CURRENT-STATE.md`, and safe local checkouts.

Do not create duplicate branches or pull requests. A merged but incomplete delivery reopens its owner and uses a fresh branch. A distinct outcome receives one focused follow-up issue.

After a standalone issue completes, run Next and report the next target without starting it. A child continues only within its parent rules. For parent selectors, also read [parent delivery](parent-delivery.md).
