# Next

Next is read-only routing. It also handles a greeting, project walkthrough,
status question, or "what next?" request in a Falryn checkout. Read the Next
section of the canonical Development contract and
[Issue governance](issue-governance.md) before acting; it never changes issue,
Project, branch, pull-request, or source state.

1. Read the authenticated GitHub identity, then the Falryn Roadmap, both issue
   repositories, native hierarchy and blockers, Project Status, Priority and
   Readiness, active delivery bundles, review/check state, and CURRENT-STATE.md.
2. Resume a valid open delivery pull request or interrupted parent chain before
   unrelated work. A bare In Progress field, recent update, or board position
   is not delivery proof.
3. Otherwise run or reproduce the repository-owned Roadmap projection. Native
   blockers form a topological order. Resolve each eligible frontier by an
   explicitly approved P0, canonical milestone order, P1 through P3,
   descending open transitive dependents, then creation time, repository, and
   issue number. Closed and Historical issues are excluded; parents route
   through their sequenced children.
4. Readiness decides the mode. Route a selected Not Ready issue to Plan and a
   selected Ready issue to Deliver. For another account's issue, name that
   owner rather than taking it over. Missing ownership routes to assignment and
   Plan. Manual modes remain for work outside Deliver, including PR/milestone
   audits and separately authorized releases.
5. Treat the projection as bound to its exact GitHub generation. Regenerate it
   after milestone, hierarchy, blocker, Status, Priority, Readiness, issue, or
   closing-PR changes; never fall back to board order or update recency.
6. When a product decision or external prerequisite blocks progress, emit
   Suggested next prompt: none and name it.

Next never starts the suggested work and never emits a Parent chain selector
except to resume a host-interrupted in-flight chain.

Read [Reporting](reporting.md) for the exact final form.
