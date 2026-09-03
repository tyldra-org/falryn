# Deliver delta

Canonical owner: [`DEVELOPMENT.md#deliver-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#deliver-mode).

Deliver is one controller for one resolved PR-sized issue at a time. It serially performs readiness, implementation, fresh verification, bounded correction, and only then the canonical full-bundle merge and reconciliation authorized by the originating Deliver request.

- Re-resolve live state at every mutation boundary.
- Never create phase agents, goal wrappers, duplicate branches, duplicate PRs, or parent mega-PRs.
- Preserve docs-first/application-last bundle order and exact partial-failure reporting.
- Return verified gaps to the same issue's correction path.
- Stop at canonical product-decision, merge-precondition, conflict, authorization, or no-progress limits.

For a parent target, also read [parent delivery](parent-delivery.md).
