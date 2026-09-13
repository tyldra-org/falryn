# Next

Next is read-only routing over the private Falryn Roadmap. It never mutates issues, Project fields, branches, pull requests, source, or documentation.

Apply [shared execution efficiency](execution-efficiency.md) within Next's read-only boundary. Use the required audit and routing evidence without preparing implementation or starting the suggested prompt.

## Required authority

Require authenticated access to the exact private Roadmap and both repositories represented in its audit. Run the exact live or replay command in [governance audits](governance-audits.md). Do not manually reproduce priority, readiness, dependency, liveness, or delivery order.

Without private Roadmap access, return:

```text
Next unavailable: authenticated maintainer Roadmap access is required. Explicit public issue and PR inspection remains available.
```

Do not list, infer, or approximate private candidates from public issue numbers, release targets, recency, labels, or board-independent guesses. Do not suggest making the Project public.

## Routing

If the audit emits any diagnostic, report it and produce no sequence. Otherwise,
recommend exactly one next issue using its generated `deliverySequence` position.

### Resolve the selection scope

`Next - Target: Falryn Roadmap` and an unqualified Roadmap "what next?" select
across the whole generated list. A previously discussed blocked issue does not
silently restrict that request to its prerequisites. When the user explicitly
asks for work within an issue, parent, or target release, retain that scope and
use the same generated order among its eligible entries. Identify any required
prerequisite outside that scope instead of silently changing the target.

Resume a valid active delivery or interrupted parent chain only when it is
established as the work being continued in this task. Assignment, In Progress
status, or parent-continuation liveness alone does not establish that intent.
For a broad Next request with several active candidates, use generated order.

### Select one owned, actionable entry

Resolve "my issues" to the authenticated maintainer identity. Walk the generated
list in its existing order, joining each entry to that generation's issue and
Project facts. Keep the original position when filtering; never sort again by
issue number, update time, assignment count, or a preferred topic.

- Consider open leaf issues in the requested scope whose sole assignee is that
  maintainer. Skip another owner's independent work without taking it over.
- Exclude an issue while any native prerequisite remains open. The generated
  list is a delivery order, not a claim that all listed work can start now.
  An earlier position does not mean its prerequisite has already completed.
- At the first owned, unblocked entry, use Deliver for Ready or Needs Planning.
  Needs Planning enters Deliver's planning stage; it does not justify choosing
  a later Ready issue. If that entry Needs Decision, name its decision owner
  and stop rather than bypassing the decision with a later recommendation.
- Recheck the selected issue's live state, owner, blockers and closing PRs.
  Changed routing facts require a fresh audit before selecting again. A verified
  open delivery PR uses its PR selector; otherwise use the issue selector.
  Qualify private docs-owned issues and PRs with `Docs`.

An assigned backlog does not require the user to choose from a menu. Return one
issue, its original sequence position and why it is actionable. A broad Next
request defaults to one leaf delivery, not a new parent chain. A parent filter
still selects one child; suggest a new chain only when the user asks for chain
delivery.
If no owned entry can proceed, name the blocking owner, decision or scope
constraint and return `Suggested next prompt: none`.

### Routing examples

| Observed request and generated list | Result |
| --- | --- |
| Broad Next; several assigned Ready leaves | Choose the first unblocked owned leaf in generated order. |
| First entry belongs to another owner; second is owned and unblocked | Choose the second entry and retain its original position. |
| Earlier owned entry is blocked; a later owned entry is unblocked | Choose the later entry; do not treat list order as completed dependency work. |
| First owned, unblocked entry Needs Planning; next is Ready | Choose the first entry with Deliver. |
| Several parents are In Progress; no delivery is being continued in this task | Choose one leaf from the generated list. |
| Prior discussion followed a blocked issue; user now asks broad Roadmap Next | Select across the whole list, not only that issue's prerequisite chain. |
| User explicitly asks for one target's next work | Filter to that scope without reordering or silently expanding it. |

## Continuation

Use [shared continuation routing](targets-and-transitions.md#suggest-the-next-action)
for the selected object and scope. Needs Planning can enter Deliver's planning
phase. Missing authority, a named decision, another owner, or audit diagnostics
remain prerequisites. Next never starts the suggested work.

Report the audit generation, selected repository and issue, sequence position, readiness, owner, blockers, active delivery evidence, and one exact `Suggested next prompt:`. If no safe route exists, use `Suggested next prompt: none` and name the prerequisite without disclosing private content.
