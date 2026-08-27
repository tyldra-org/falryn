# Issue governance

Read this before creating, materially editing, routing, or implementing a
Falryn work issue. The canonical policy is
[falryn-docs/ISSUE-GOVERNANCE.md](https://github.com/tyldra-org/falryn-docs/blob/main/ISSUE-GOVERNANCE.md);
that document wins if this reference conflicts.

An open work issue must have all of the following before it is Ready:

- Falryn Roadmap membership;
- exactly one GitHub assignee;
- Project Status set to **Todo**, **In Progress**, or **Done**;
- exactly one work-type label (`bug` or `type:*`) and at least one `area:*`
  label; and
- a native parent or explicit **Standalone** relationship.

`epic` marks a parent outcome but never substitutes for a work type. Use the
Project's native **Parent issue** and **Sub-issues progress** fields for parent
work; do not recreate hierarchy or progress in labels or checklists. A
standalone issue has no fabricated child progress.

Keep planned or blocked work **Todo**. Move an issue to **In Progress** only
when its sole assignee's authenticated GitHub account starts implementation;
start the open parent when its first required child begins. Set **Done** only
after the issue is closed and its proof is reconciled. Reopened work returns to
Todo until active work restarts.

For a target owned by another account, do not write source, branches, pull
requests, or implementation state. Plan, Verify, and read-only routing remain
valid; route the next implementation prompt to the actual owner. Reassignment
is an explicit GitHub update, never an implied handoff.
