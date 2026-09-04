# Documentation delivery

Falryn Docs owns stable product and architecture contracts. Public Falryn owns source, tests, `DEVELOPMENT.md`, `CURRENT-STATE.md`, code-adjacent guidance, and complete public implementation handoffs. Keep that boundary intact while delivering one coherent outcome.

## Resolve documentation owners

Authenticated maintainers read the exact Falryn Docs revision, `DOCUMENTATION-MAP.md`, and the issue's canonical links. Identify only the pages whose owned contract the change can affect. Do not copy the private documentation tree into the public checkout or create a second public architecture owner.

Without private access, inspect the public issue, source, tests, `CURRENT-STATE.md`, and pull-request evidence. Record documentation verification as unavailable or update-required from public evidence. Do not invent a private path, page title, or unaffected claim.

## Classify impact

For each resolved private owner, use one internal classification:

| Classification | Meaning |
| --- | --- |
| `create` | No canonical owner covers a selected contract that now needs one |
| `update` | The selected behavior changes an existing canonical contract |
| `verify-unaffected` | The owner was checked at the exact revision and remains accurate |
| `not-applicable` | The change cannot affect that documentation concern |

Translate that into the public delivery record without private content:

- `private-update-required` for `create` or `update`;
- `private-verify-unaffected` for verified unaffected owners;
- `private-verification-unavailable` when the actor cannot inspect a private owner;
- `public-code-adjacent-update` for `CURRENT-STATE.md`, contributor controls, fixtures, comments, or other public repository-owned guidance; or
- `not-applicable` when no documentation owner is affected.

Name the evidence class and result, not private prose. A public contributor may declare likely impact, but an authenticated maintainer settles any required private verification before merge.

## Choose the delivery owner

A product change keeps its PR-sized public Falryn issue as the delivery owner. A required Falryn Docs pull request is a companion to that issue. It uses a repository-qualified reference such as `Refs tyldra-org/falryn#N`, cross-links the application pull request, and does not create or close a same-numbered docs issue by inference.

Create a separate Falryn Docs issue only when the documentation work has an independently reviewable outcome and lifecycle. Pure docs work uses the explicit `Docs issue`, `Docs PR`, or docs-parent selector from [targets and transitions](targets-and-transitions.md).

## Prepare companions

Before Verify, require every companion to identify:

- the same public delivery owner or exact docs-only owner;
- its documentation classification and canonical owners;
- exact base and head revisions;
- reciprocal links to the application pull request and other required companions;
- checks and review state; and
- a final squash subject plus the approved empty body or one useful repository-qualified issue-reference footer.

Keep proposed behavior labeled as proposed until source and validation prove it. After application delivery, update only the verified parts to current behavior. `CURRENT-STATE.md` remains the concise source-backed inventory and never becomes a roadmap.

## Verify and merge

Verify the application and documentation diffs together even though the repositories merge separately. Recheck claims against the selected source revision, test evidence, public issue acceptance, canonical owners, and release state.

For an authenticated bundle, merge every required private docs companion first. Re-read the application pull request after those merges, then merge the application pull request last. Stop on the first unexpected result. A partial bundle is not complete, and a merged docs companion does not authorize a stale or failing application merge.

Afterward, verify both merge commits, intended issue closures, Project reconciliation, parent state, `CURRENT-STATE.md`, and safe default-checkout synchronization. Release publication and branch deletion remain separate actions.

## Privacy boundary

Private paths may appear only in the maintainer's local report when they help navigation. Never place them, private page text, issue bodies, Project fields, snapshots, or authenticated API responses in public commits, issues, pull requests, checks, logs, or artifacts. Public output may state only the classification and delivery fact needed to understand the change.
