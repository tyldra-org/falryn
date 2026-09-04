# Verify

Verify audits the exact target without editing product source, pull-request contents, or private documentation.

## Public application PR

Inspect the exact base and head revisions, complete diff, public delivery issue, source behavior, tests, `CURRENT-STATE.md`, checks, reviews, rulesets, mergeability, documentation-impact declaration, and available clean local checkout state.

Public-only verification may conclude whether the application revision satisfies its public contract. It must not claim full delivery-bundle readiness when private documentation impact is required or unresolved.

## Authenticated delivery bundle

When private authority is available, apply [documentation delivery](documentation-delivery.md) and inspect every required private docs companion, cross-link, documentation owner, exact head, check, review, mergeability result, and merge order. Preview:

- every repository and pull request;
- exact reviewed head SHA;
- docs-first and application-last order;
- squash method and final subject;
- any allowed short issue-reference footer or an empty body; and
- each eligible local checkout and safe post-merge default branch.

Do not merge. Any later head, base, check, review, ruleset, companion, message, checkout, or mergeability change invalidates the preview.

## Other targets

- A PR-sized issue verifies delivered behavior against every public acceptance criterion and, for maintainers, private documentation and Project reconciliation.
- A parent requires all necessary children complete plus integrated behavior, failure, recovery, resource, security, and projection evidence.
- A milestone or range requires private Roadmap and documentation authority.
- A docs-only target requires private Falryn Docs authority.

Verify may perform only explicit governance reconciliation that the user authorized, such as reopening incomplete merged work, correcting issue and Project state, recording a missing PR-sized owner, or closing a fully proven parent. It never silently fixes source.

When a gap exists, route through [corrections](corrections.md). Report unavailable private evidence separately from a public implementation defect. Use [governance audits](governance-audits.md) before making a readiness, sequence, liveness, or complete-reconciliation claim.
