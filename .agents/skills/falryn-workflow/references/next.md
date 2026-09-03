# Next delta

Canonical owner: [`DEVELOPMENT.md#next-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#next-mode).

Next is read-only. Run the repository-owned live Roadmap audit, or replay a captured snapshot through that same auditor. Never manually reproduce priority, readiness, dependency, liveness, or delivery ordering.

If the audit reports any diagnostic, report it and do not route work. Otherwise:

- resume an authoritative active delivery first;
- route a Ready selection to Deliver;
- route a Not Ready selection to Plan;
- route parent outcomes through their selected actionable child;
- use Falryn Docs-qualified forms only for docs-owned work.

Return the exact state evidence and one copy-ready suggested prompt. Do not execute it.
