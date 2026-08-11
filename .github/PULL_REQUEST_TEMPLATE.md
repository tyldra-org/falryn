## Target and outcome

Closes #

<!-- Use Refs # instead when this PR does not fully resolve the issue. -->

## Delivery identity

- Delivery owner:
- Companion docs PR or not applicable:

## Scope

<!-- Summarize the implementation shape and affected contracts. -->

## Validation

<!-- List exact commands or checks and their observed results. -->

- [ ] Focused tests and relevant negative cases pass.
- [ ] `bun run check` passes, or the limitation is recorded.
- [ ] `bun run build` passes when packaging or runtime composition changed.

## Documentation

- [ ] `CURRENT-STATE.md` reflects only behavior supported by this change.
- [ ] Affected canonical owners were located through `falryn-docs/DOCUMENTATION-MAP.md` or the issue's canonical links.
- [ ] Each relevant owner is classified as `create`, `update`, `verify-unaffected`, or `not-applicable`, with a reason.
- [ ] The implementation stays within the Ready issue and canonical contracts; any contract change is explained and linked.
- [ ] The existing canonical owner was updated instead of creating a duplicate contract, roadmap, or implementation inventory.
- [ ] Not user-facing, or the related `falryn-docs` pull request is cross-linked for coordinated landing.
- [ ] Any companion docs PR references this delivery owner and links back to this delivery PR.
- [ ] Repository-qualified paths and GitHub links are shareable; no contributor-specific local path is persisted.

## Risk and limitations

<!-- Include platform, security, privacy, data, compatibility, or remaining-work limits. -->

## Delivery checklist

<!-- Maintainer / optional delivery-workflow checklist. Ordinary collaborator
     PRs need Target, Scope, Validation, and Documentation; the items below are
     not a contribution bar. -->

- [ ] The target is one Ready, unblocked PR-sized issue.
- [ ] The issue is assigned and **In Progress**.
- [ ] Its parent is **In Progress** when this is the first required child to begin.
- [ ] The branch targets the current default branch and contains no unrelated work.
- [ ] Any parent remains open and **In Progress** for integrated verification.
- [ ] The PR title is a clean conventional subject suitable for squash merge.
- [ ] The squash commit is subject-only by default; any body is limited to one useful short issue-reference footer.
- [ ] Validation, risks, documentation impact, companion links, delivery details, and incremental messages remain in this PR rather than the squash commit.
- [ ] Verify includes every required companion and previews docs-first/application-last merge order.
- [ ] Verify identifies available local checkouts and previews safe post-merge default-branch synchronization.
