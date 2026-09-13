# Documentation delivery

Public Falryn owns code-adjacent guidance, contributor controls, `DEVELOPMENT.md`,
`CURRENT-STATE.md`, fixtures, comments and complete public issue handoffs.
Falryn Docs owns canonical product and architecture contracts. Keep one owner
for each fact and update the owner affected by the change.

## Resolve and classify impact

With [Docs authority](private-authority.md), read `DOCUMENTATION-MAP.md` and the
issue's canonical links at a recorded revision. Inspect only affected owners.
Use the private repository's writing and validation rules for docs changes.

| Private owner result | Public delivery classification |
| --- | --- |
| `create`: no owner covers a required contract | `private-update-required` |
| `update`: the owned contract changes | `private-update-required` |
| `verify-unaffected`: inspected owner remains accurate | `private-verify-unaffected` |
| Owner cannot be inspected | `private-verification-unavailable` |
| A public code-adjacent owner changes | `public-code-adjacent-update` |
| No documentation concern applies | `not-applicable` |

Several public classifications may apply; `not-applicable` is exclusive. Without
private access, use public evidence to identify likely impact or unavailable
verification. Never invent a private page or relabel unavailable as unaffected.
An authenticated maintainer settles required private evidence before merge.

## Resolve the delivery owner

Application behavior keeps its PR-sized public Falryn issue as owner. A required
Docs PR is its companion: `Refs tyldra-org/falryn#N`, with reciprocal application
PR links and the same delivery owner. Create a separate Docs issue only when
private work has an independently reviewable outcome and lifecycle.

A docs-only issue owns its own Docs PR. Use `Closes #N` only when that PR fully
completes that Docs issue. Equal numbers across repositories establish no
relationship. A request limited to a companion does not authorize the application
merge; resolve scope through [targets](targets-and-transitions.md#resolve-a-delivery-target).

## Prepare and verify

A companion records its exact owner, canonical pages, classifications, source
revision, base/head SHAs, reciprocal PR links, checks, reviews and final squash
message. Keep private page details in the private record; public links disclose
only the necessary relationship.

Label proposed behavior as proposed until source and validation prove it.
`CURRENT-STATE.md` is the concise implemented inventory, never a roadmap. After
delivery, reconcile current-behavior claims only where the source proves them.

[Verify](assessment.md#verify) application and required documentation changes as
one bundle against the issue acceptance and exact source revisions. Use
[Merge](merge.md) for docs-first ordering, partial-result handling and final
reconciliation. Neither a merged companion nor an unavailable owner proves the
application's documentation obligation complete.
