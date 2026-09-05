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
3. route Ready work to Deliver and Needs Planning work to Plan;
4. route Needs Decision to its named human decision owner and do not suggest Plan or Deliver until the decision is recorded;
5. route a parent through its selected actionable child;
6. respect the sole assignee and name another owner rather than taking over; and
7. use Falryn Docs-qualified selectors only for private docs-owned work.

Parent-chain selectors are resume-only. Next never starts work or invents authorization.

Report the audit generation, selected repository and issue, sequence position, readiness, owner, blockers, active delivery evidence, and one exact `Suggested next prompt:`. If no safe route exists, use `Suggested next prompt: none` and name the prerequisite without disclosing private content.
