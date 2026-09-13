# Deliver

Deliver completes the named outcome through planning, implementation, review,
verification, merge and reconciliation. Resolve the target once through
[targets and transitions](targets-and-transitions.md#resolve-a-delivery-target),
then resume from observed state. Keep one controller in the current task.

The originating request authorizes in-scope delivery and merge at freshly
verified revisions, including required companions when its scope covers them.
It does not cover another owner's work, unrelated outcomes, release publication
or destructive cleanup. Apply [private authority](private-authority.md) only to
operations that need it.

## Complete the remaining work

| Observed state | Next step |
| --- | --- |
| Missing derivable contract facts | [Plan](plan.md) the same issue; retain the requested acceptance |
| Named human decision or open prerequisite | Report the owner or prerequisite; do not implement through it |
| Complete, unblocked issue without its full implementation | [Implement](implement.md), reusing a valid branch and PR |
| Candidate PR exists | [Review](assessment.md#review) the complete current diff and [Verify](assessment.md#verify) the bundle |
| In-scope defect or failed check | Repair its owner, validate the change and reassess the new revision |
| Required CI still pending | Wait and do independent useful work; retain the same delivery |
| Fresh passing Verify and merge preflight | [Merge](merge.md) and reconcile |
| Target already merged | Verify completion and finish any missing reconciliation |

Read a stage guide when its work is needed. Skip already satisfied stages whose
proof remains valid. Manual stage finish lines do not end Deliver. Follow
[execution](execution.md) for evidence refresh, uncertain effects and bounded
repair. Do not send separate Review, Verify or Merge prompts merely because the
controller reached that stage.

Preserve acceptance when a prerequisite is missing. Resolve derivable planning
facts in the current scope; identify work outside it. A user's instruction to
resolve prerequisites authorizes that bounded dependency work, not unrelated
Roadmap selection. Do not silently narrow the outcome to make it deliverable.

For parents, use [parent delivery](parent-delivery.md). Otherwise finish after
this delivery and use [continuation routing](targets-and-transitions.md#suggest-the-next-action).
Access to the Roadmap alone is not a reason to start or select more work.

## Recover from observed state

These are recovery choices, not additional mutation authority. Manual Review
stays read-only; Verify changes only explicitly authorized governance records.

| Observed delivery | Recovery within authorized scope |
| --- | --- |
| Open PR with missing acceptance | Keep the issue, branch, PR and valid companions; add focused commits |
| PR closed without merge | Reopen only if head branch, base, scope, owner and companions remain valid; otherwise prepare a replacement |
| Merged but incomplete original acceptance | Reopen the owning issue, reconcile stale completion, and use a fresh branch from current default |
| Distinct new outcome | Give it one focused follow-up issue rather than expanding completed acceptance |
| Issue-free maintenance already merged but incomplete | Establish a focused correction owner and fresh PR |
| Uncertain or partial external effect | Read what actually landed before retrying or continuing |

Never edit a merged PR or reuse its squash-merged branch. A prior merge does
not prove remaining acceptance. Keep partial delivery visible, including merged
docs with an unmerged application. Every changed candidate needs fresh review,
verification and merge preflight.
