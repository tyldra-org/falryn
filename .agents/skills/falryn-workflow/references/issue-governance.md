# Issue governance

Falryn issues own implementation work. Private Roadmap fields own maintainer scheduling but never replace a complete public issue body.

## Public issue contract

Before an issue can be treated as implementation-ready, its public body must identify:

- the observed shipped baseline and exact remaining outcome;
- included behavior, non-goals, and one PR-sized ownership boundary;
- native parent, children, and blocker relationships where applicable;
- typed inputs, outputs, state, effects, limits, failures, cancellation, partial and unavailable behavior, recovery, and cleanup relevant to the slice;
- the real CLI, OpenTUI, headless, model, export, replay, diagnostic, or other product composition point;
- focused positive, negative, restart, resource, and platform validation;
- documentation impact without requiring the implementer to read private content; and
- a non-empty Ready checklist whose checked facts remain current.

A private documentation link is supplementary. If removing access to that link makes the issue ambiguous, the issue is `Needs Planning`.

Use native GitHub hierarchy and blockers. A parent owns an integrated outcome and routes through PR-sized children; it never owns a branch or mega-pull request. A standalone issue uses the repository's exact affirmative standalone marker. Do not infer hierarchy or blockers from incidental prose.

## Public-only behavior

An agent without private Roadmap access may inspect and improve the public contract. It may not assert Roadmap Status, Priority, Readiness, sequence position, or ownership metadata it cannot observe. It reports `private-roadmap-unavailable` and stops before a transition that requires those fields.

Ordinary contributors do not need maintainer Project access. They follow the public issue, `CONTRIBUTING.md`, source, and checks. A maintainer performs private triage and delivery reconciliation.

## Maintainer behavior

With authenticated Roadmap access, resolve the issue's exact repository, assignee, milestone, Status, Priority, Readiness, Project item, native parent and children, blockers, and linked pull requests. Keep these rules:

- Todo covers planning and blocked work.
- In Progress requires active implementation. A leaf without an open closing PR follows the private liveness limit.
- Done requires closure and complete delivery proof.
- Open blockers prevent implementation.
- Ready is evidence about contract completeness, not blocker absence.
- Needs Planning means the public contract still lacks current evidence.
- Needs Decision requires a named maintainer decision in the public issue; it is not a generic blocked state.
- Parent and Historical states never create implementation slots.

Use the exact option meanings and transitions in [Roadmap fields and automation](roadmap-fields.md). New open leaves default to Todo, P2, and Needs Planning. Feature, bug, documentation, infrastructure, maintenance, and research issues share this same governance boundary; work type never changes the meaning of Priority or Readiness.

Run the exact repository-owned commands in [governance audits](governance-audits.md) after governance mutations. Any diagnostic suppresses routing until reconciled.

## Mutation safety

Before replacing a body or field, retain the exact preimage, validate the complete candidate, re-read current state, apply only to the resolved issue or Project item, and verify the result. Do not pipe fallible generated output directly into a mutation. Bulk work must be bounded, repeat-safe, and report partial results per issue.
