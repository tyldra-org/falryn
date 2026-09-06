# Deliver

Deliver is one controller for completing a resolved delivery, one PR-sized
outcome at a time. Issue, PR, docs, and parent inputs use the same
[target resolution](targets-and-transitions.md#resolve-a-delivery-target) and
continue from observed state. It never creates separate planner, implementer,
verifier, goal-wrapper, or parent-branch machinery.

## Authority

Require authenticated authority for every operation in the resolved scope.
Roadmap-owned work and parent sequencing require private Roadmap access and
[governance audits](governance-audits.md). Private docs work or a required docs
companion requires Falryn Docs access and [documentation delivery](documentation-delivery.md).
An ordinary public contribution or issue-free maintenance PR does not acquire
private Project requirements by entering through Deliver. Unresolved private
documentation impact still blocks complete delivery. Return `unavailable`
before a mutation that lacks required authority, naming the missing prerequisite.

The originating Deliver request authorizes completion and merge only within its
resolved scope, at freshly verified revisions, including required companions
when that scope covers them. This applies equally to application and docs-only
deliveries. Repairs require fresh review and verification; previous revision
evidence cannot authorize a changed head. Missing checks, unresolved reviews,
changed ownership, and unrelated PRs are not covered.

## Efficient execution

Apply [shared execution efficiency](execution-efficiency.md) throughout the existing controller loop. Deliver alone composes modes; evidence reuse never authorizes a manual mode to enter this loop. Keep bounded repairs, exact-revision verification, docs-first merge, and reconciliation unchanged.

## Controller loop

Load the guide for a stage when its work is needed: [Plan](plan.md),
[Implement](implement.md), [Review](review.md), [Verify](verify.md), or
[Merge](merge.md). Apply its evidence and validation requirements within this
controller's authority. Manual-stage stopping points do not end Deliver, and
an already satisfied stage needs no repeated work merely to follow the list.

1. Resolve the exact target, owner, requested scope, existing PRs, companions, blockers, and applicable Project state. Apply assignment and readiness requirements only to work governed by them.
2. Establish the remaining work from current evidence. Plan missing contract facts before implementation; keep Roadmap work Todo until implementation is admitted. A named human decision remains a stop condition.
3. Reuse valid branches and PRs. Implement or repair only missing acceptance within the resolved scope; set Roadmap work In Progress when implementation begins. A docs-only outcome edits its docs owner, not application code.
4. Review the current diff and verify the exact authorized bundle. Reuse unchanged trustworthy evidence, but refresh merge preconditions. An already complete PR proceeds to verification rather than repeating planning or implementation.
5. Wait for required checks and resolve in-scope findings inside this controller. Do not hand the user separate Review, Verify, or Merge prompts merely because that stage has been reached.
6. Return actionable gaps to the same owner and branch, require observable progress, then review and verify the new revision.
7. After three repair passes without changed evidence, stop for a different strategy.
8. Merge required docs companions first and the application last under [Merge](merge.md). A docs-only delivery merges its docs PR; a scoped companion request stops after that member.
9. Reconcile the applicable issue, Project, parent, documentation, and safe local checkouts. Update `CURRENT-STATE.md` only when application behavior changed. Verify an already-merged target and finish missing reconciliation instead of merging again.

Do not create duplicate branches or pull requests. Use [corrections](corrections.md)
for closed or merged work; never reopen or edit a merged PR. A distinct outcome
receives one focused follow-up issue.

After a standalone delivery completes, use
[continuation routing](targets-and-transitions.md#suggest-the-next-action).
Use Next for requested Roadmap selection with verified authority. Access alone
does not require finding more work; report no next action when the outcome is
complete and no useful continuation is established. A child continues only
within its parent rules. For parent selectors, read [parent delivery](parent-delivery.md).
