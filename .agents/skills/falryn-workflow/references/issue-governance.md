# Issue governance

Read this before creating, materially editing, routing, or implementing a
Falryn work issue. The canonical policy is
[falryn-docs/ISSUE-GOVERNANCE.md](https://github.com/tyldra-org/falryn-docs/blob/main/ISSUE-GOVERNANCE.md);
that document wins if this reference conflicts.

An open work issue must have all of the following before it is Ready:

- exactly one Falryn Roadmap issue item;
- exactly one GitHub assignee and repository milestone;
- Project Status set to **Todo**, **In Progress**, or **Done**;
- Project Priority set to **P0**, **P1**, **P2**, or **P3**;
- Project Readiness set to **Ready** or **Not Ready** for leaves and
  **Parent** for parent outcomes;
- exactly one work-type label (`bug` or `type:*`) and at least one `area:*`
  label; and
- a native parent or explicit **Standalone** relationship.

`epic` marks a parent outcome but never substitutes for a work type. Use the
Project's native **Parent issue** and **Sub-issues progress** fields for parent
work; do not recreate hierarchy or progress in labels or checklists. A
standalone issue has no fabricated child progress. Keep native hierarchy one
level deep. Preserve the parent's milestone unless the child is an explicitly
declared `early-prerequisite-v1` in a strictly earlier milestone.

Keep planned or blocked work **Todo**. Move an issue to **In Progress** only
when its sole assignee's authenticated GitHub account starts implementation. A
leaf may own at most one open closing PR and is In Progress while that PR is
open. A parent never owns a closing PR; start it when a child starts or closes
and retain In Progress through integrated verification after the final child
closes. An open leaf without an open closing PR has seven calendar days to
expose a draft PR or return to Todo. Set **Done** only after the issue is closed and its proof is
reconciled. Closed issues use Historical Readiness and retain P0–P3, or use
Historical Priority when no contemporaneous rank exists. Reopened Historical
work returns to Todo, Not Ready, and current P0–P3 triage.

Native blockers decide hard order. Among the eligible topological frontier,
Next uses valid active delivery, explicitly approved P0, canonical milestone
order, P1 through P3, open transitive dependents, creation time, repository,
and issue number. Board position and update recency never decide the sequence.
Not Ready routes to Plan; Ready routes to Deliver; parents route through their
sequenced children.

For a target owned by another account, do not write source, branches, pull
requests, or implementation state. Plan, Verify, and read-only routing remain
valid; route the next implementation prompt to the actual owner. Reassignment
is an explicit GitHub update, never an implied handoff.
