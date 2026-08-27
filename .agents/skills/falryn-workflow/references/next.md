# Next

Next is read-only routing. It also handles a greeting, project walkthrough,
status question, or "what next?" request in a Falryn checkout. Read the Next
section of the canonical Development contract and
[Issue governance](issue-governance.md) before acting; it never changes issue,
Project, branch, pull-request, or source state.

1. Read the authenticated GitHub identity, then the Falryn Roadmap, issue
   hierarchy, dependencies, Project status,
   active delivery bundles, review/check state, and CURRENT-STATE.md.
2. Validate the Planning frontier and its required transition. If it conflicts
   with live GitHub state, name the mismatch and follow the live transition.
3. Resume an in-flight Deliver target before unrelated work. Otherwise select
   the unblocked native graph by explicit Priority (P0 through P3), then stable
   issue creation order—not board position or recency.
4. For an eligible Falryn issue or parent owned by the authenticated account,
   emit the matching Deliver target. When another account owns it, name that
   owner and route the target to that owner instead; do not suggest that the
   current account implement it. When an eligible target lacks an owner, route
   to assignment or Plan before implementation. Suggest a manual mode only when
   Deliver cannot own the selected scope, such as a PR/milestone audit or a
   separately authorized release.
5. When a product decision or external prerequisite blocks progress, emit
   Suggested next prompt: none and name it.

Next never starts the suggested work and never emits a Parent chain selector
except to resume a host-interrupted in-flight chain.

Read [Reporting](reporting.md) for the exact final form.
