# Next

Next is read-only routing. Read the Next section of the canonical Development
contract before acting; it never changes issue, Project, branch, pull-request,
or source state.

1. Read the Falryn Roadmap, issue hierarchy, dependencies, Project status,
   active delivery bundles, review/check state, and CURRENT-STATE.md.
2. Validate the Planning frontier and its required transition. If it conflicts
   with live GitHub state, name the mismatch and follow the live transition.
3. Resume an in-flight Deliver target before unrelated work. Otherwise select
   the unblocked native graph by explicit Priority (P0 through P3), then stable
   issue creation order—not board position or recency.
4. For an eligible Falryn issue or parent, emit the matching Deliver target.
   Suggest a manual mode only when Deliver cannot own the selected scope, such
   as a docs-only task, PR/milestone audit, or separately authorized release.
5. When a product decision or external prerequisite blocks progress, emit
   Suggested next prompt: none and name it.

Next never starts the suggested work and never emits a Parent chain selector
except to resume a host-interrupted in-flight chain.

Read [Reporting](reporting.md) for the exact final form.
