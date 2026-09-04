# Issue governance

Falryn repository issues own public discussion and contribution work. The private Roadmap owns only the maintainer's selected product-development work.

## Public issue contract

Before a contribution issue can own a non-draft pull request, its public body must identify:

- the observed shipped baseline and exact remaining outcome;
- included behavior, non-goals, and one PR-sized ownership boundary;
- relevant blockers and dependencies;
- enough scope, behavior, failure, and recovery context to review the proposed slice;
- focused validation appropriate to the change;
- documentation impact without requiring the implementer to read private content; and
- a non-empty Contribution checklist whose checked facts remain current.

A private documentation link is never a contribution requirement. If removing access to it makes the public change ambiguous, the public contract is incomplete.

Use native GitHub blockers when they exist. Private product planning may add native hierarchy after adopting an issue, but contributors do not need to create or infer that hierarchy.

## Public-only behavior

An agent without private Roadmap access may inspect and improve the public contribution contract and work on an explicitly authorized contribution. It may not assert Roadmap Status, Priority, Readiness, sequence position, or ownership metadata it cannot observe. A missing private connection does not block ordinary contribution work.

Ordinary contributors do not need maintainer Project access. They follow the public issue, `CONTRIBUTING.md`, source, and checks. They never assign or wait for a milestone or private field.

## Maintainer behavior

Project membership means a maintainer deliberately adopted the issue into product development. Only then resolve its exact repository, assignee, milestone, Status, Priority, Readiness, Project item, native parent and children, blockers, and linked pull requests. Keep these rules:

- Todo covers planning and blocked work.
- In Progress requires active implementation. A leaf without an open closing PR follows the private liveness limit.
- Done requires closure and complete delivery proof.
- Open blockers prevent implementation.
- Ready is evidence about contract completeness, not blocker absence.
- Needs Planning means the public contract still lacks current evidence.
- Needs Decision requires a named maintainer decision in the public issue; it is not a generic blocked state.
- Parent and Historical states never create implementation slots.

Use the exact option meanings and transitions in [Roadmap fields and automation](roadmap-fields.md). Newly adopted Roadmap leaves default to Todo, P2, and Needs Planning. Feature, bug, documentation, infrastructure, maintenance, and research issues may all be adopted, but their public work type never creates Roadmap membership or changes the meaning of Priority or Readiness.

Run the exact repository-owned commands in [governance audits](governance-audits.md) after governance mutations. Any diagnostic suppresses routing until reconciled.

## Mutation safety

Before replacing a body or field, retain the exact preimage, validate the complete candidate, re-read current state, apply only to the resolved issue or Project item, and verify the result. Do not pipe fallible generated output directly into a mutation. Bulk work must be bounded, repeat-safe, and report partial results per issue.
