# Corrections

Use this guide after a Verify gap or when a delivery PR is closed, incomplete,
or already merged.

| Observed state | Correct response |
| --- | --- |
| Open valid PR | Keep its issue, branch, and PR. Add focused implementation commits, then run a new Verify. |
| Closed without merge | Reopen only if its head, target, and issue scope remain valid. Otherwise use a fresh branch and replacement PR. |
| Merged but acceptance incomplete | Reopen the owning issue, reconcile stale **Done** to **Todo**, and implement from a fresh branch based on the updated default branch. |
| Distinct outcome | Create one focused follow-up issue. |
| Parent integration gap | Create one dedicated native integration child; never modify completed child PRs or create a parent mega-PR. |

Every push invalidates the prior Verify result, merge preview, and approval
tied to the former head. Do not reuse a squash-merged branch for corrections.
Reverting a landed change is a separately authorized workflow.
