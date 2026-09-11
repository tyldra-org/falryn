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

If the audit emits any diagnostic, report it and produce no sequence. Otherwise:

1. resume one valid active delivery or interrupted parent chain first;
2. select the first actionable entry in the generated dependency-safe sequence;
3. prefer Deliver for both Ready and Needs Planning work; Deliver plans the selected issue before implementation when needed, so an unchecked Ready checklist alone is not a reason to suggest manual Plan;
4. route Needs Decision to its named human decision owner and do not suggest Plan or Deliver until the decision is recorded;
5. route a parent through its selected actionable child;
6. respect the sole assignee and name another owner rather than taking over; and
7. use Falryn Docs-qualified selectors only for private docs-owned work.

## Continuation

Use [shared continuation routing](targets-and-transitions.md#suggest-the-next-action)
for the selected object and scope. Needs Planning can enter Deliver's planning
phase. Missing authority, a named decision, another owner, or audit diagnostics
remain prerequisites. Next never starts the suggested work.

Report the audit generation, selected repository and issue, sequence position, readiness, owner, blockers, active delivery evidence, and one exact `Suggested next prompt:`. If no safe route exists, use `Suggested next prompt: none` and name the prerequisite without disclosing private content.
