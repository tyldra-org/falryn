# Documentation and private authority

Resolve public facts from source, tests, builds, `CURRENT-STATE.md` and the public
issue. Falryn Docs owns canonical product and architecture contracts. Use one
owner for each fact. Public contributions outside the Roadmap must remain
possible without either private authority.

## Resolve access only when needed

Docs access and Roadmap access are independent. A supplied or sibling
`../falryn-docs` checkout qualifies only after reading its `AGENTS.md` and verifying
its exact remote `tyldra-org/falryn-docs`, branch and revision. Read affected
owners through `DOCUMENTATION-MAP.md` and the issue's canonical links.
Authenticated gh access may replace local inspection when the operation allows.
Never clone private repositories automatically or rewrite an unrelated remote.

Roadmap operations need the organization-only Roadmap issue fields; use
[falryn-roadmap](../../falryn-roadmap/SKILL.md). Repository access does not prove
field access. Recheck needed authority at mutation boundaries and after
identity or repository changes. Lost required access is unavailable. Continue
independent authorized public work, but never call private verification complete.

## Classify the affected owners

| Evidence | Delivery classification |
| --- | --- |
| A required canonical page must be created or updated | `private-update-required` |
| Inspected canonical owners remain accurate at the recorded revision | `private-verify-unaffected` |
| Required private owner cannot be inspected | `private-verification-unavailable` |
| Public code-adjacent guidance, fixtures, comments or current state change | `public-code-adjacent-update` |
| No documentation concern applies | `not-applicable` |

Multiple classifications may apply; `not-applicable` is exclusive. Use private
`create`, `update`, `verify-unaffected` and `not-applicable` dispositions for each
canonical owner. Do not invent a page or convert unavailable evidence to
unaffected. Follow Docs writing and validation rules for private changes.

## Own one delivery

Application acceptance stays with its public issue. Its docs companion uses
`Refs tyldra-org/falryn#N` and reciprocal PR links. A companion does not need a
separate Docs issue unless the work has an independent outcome and lifecycle.
A docs-only issue owns its Docs PR; `Closes #N` must refer to the issue it actually
completes. Equal numbers in different repositories establish no relationship.

Record source and docs revisions, affected owners, classification, reciprocal
links, checks and reviews in their proper records. Verify application and
required docs together, following [work](work.md#merge-and-reconcile) for merge
order and partial results. Keep proposed behavior labeled until source and
validation prove it, and reconcile current-behavior claims after delivery.

## Respect the destination

Private text, issue bodies, paths, planning-field values, snapshots and authenticated
responses stay out of public commits, issues, PRs, logs and artifacts. Public
records may include the necessary delivery classification and verified companion
relationship. Never place credentials in command arguments or snapshots.

Private chat may include useful local paths and scheduling evidence. Store audit
snapshots only in restrictive temporary storage outside both repositories and
remove them after their bounded purpose. Neither private access nor a successful
audit authorizes publishing that evidence.
