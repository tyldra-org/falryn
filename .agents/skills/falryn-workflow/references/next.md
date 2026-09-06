# Next

Next is read-only routing over the private Falryn Roadmap. It never mutates issues, Project fields, branches, pull requests, source, or documentation.

Apply [shared execution efficiency](execution-efficiency.md) within Next's read-only boundary. Use the required audit and routing evidence without preparing implementation or starting the suggested prompt.

## Required authority

Require authenticated access to the exact private Roadmap and both repositories represented in its audit. Run the exact live or replay command in [governance audits](governance-audits.md). Do not manually reproduce priority, readiness, dependency, liveness, or delivery order.

Without private Roadmap access, return:

```text
Next unavailable: authenticated maintainer Roadmap access is required. Explicit public issue and PR inspection remains available.
```

Do not list, infer, or approximate private candidates from public issue numbers, milestones, recency, labels, or board-independent guesses. Do not suggest making the Project public.

## Routing

If the audit emits any diagnostic, report it and produce no sequence. Otherwise:

1. resume one valid active delivery or interrupted parent chain first;
2. select the first actionable entry in the generated dependency-safe sequence;
3. prefer Deliver for both Ready and Needs Planning work; Deliver plans the selected issue before implementation when needed, so an unchecked Ready checklist alone is not a reason to suggest manual Plan;
4. route Needs Decision to its named human decision owner and do not suggest Plan or Deliver until the decision is recorded;
5. route a parent through its selected actionable child;
6. respect the sole assignee and name another owner rather than taking over; and
7. use Falryn Docs-qualified selectors only for private docs-owned work.

## Choose the delivery scope

Prefer `Deliver - Target: Issue #N` for one selected issue. Resume a valid
interrupted chain with its exact parent-chain selector. For a new chain, prefer
`Deliver - Target: Parent chain #N` when the user's requested scope is that
parent outcome, or a broad Roadmap request and the audit establish a coherent
remaining child sequence owned by the authenticated account. Do not widen an
explicit single-issue request into a chain. A parent link alone is not enough:
verify the native hierarchy, remaining scope, ownership, and ordering first.
Use the single-issue form when only that child's delivery is established.

This preference covers Plan, Implement, Review, Verify, and Merge. An existing
implementation branch or PR, review findings, pending checks, or a verified PR
awaiting merge normally belongs to the same delivery controller. Recommend
continuing Deliver for its resolved issue or active parent chain instead of
asking the user to advance through those stages with separate prompts.

Suggest a manual mode only when the user requests that stage or step-by-step
control, or the specific task cannot be handled by the delivery controller and
requires an isolated operation. Name that concrete reason; reaching a normal
delivery stage is not one. Do not use manual modes to bypass missing authority, another
owner, an unresolved decision, or a failed audit. Those remain prerequisites.

Next recommends a prompt; it never starts delivery. A new chain suggestion
offers that scope for the user to invoke and does not itself authorize any
child's implementation or merge.

Report the audit generation, selected repository and issue, sequence position, readiness, owner, blockers, active delivery evidence, and one exact `Suggested next prompt:`. If no safe route exists, use `Suggested next prompt: none` and name the prerequisite without disclosing private content.
