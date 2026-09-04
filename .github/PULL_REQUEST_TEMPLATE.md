## Target and outcome

Closes #

<!-- Use Refs # instead when this PR does not fully resolve the issue. -->

<!-- Every non-Dependabot PR links its owning issue. Automation checks this
     field and the required sections below. -->

## Change class

- [ ] Feature or bug fix
- [ ] Documentation
- [ ] Infrastructure or dependency update
- [ ] Breaking change (also apply the `breaking-change` label)

## Delivery identity

- Delivery owner:

## Scope

<!-- Summarize the implementation shape and affected contracts. -->

## Validation

<!-- List exact commands or checks and their observed results. -->

- [ ] Focused tests and relevant negative cases pass.
- [ ] `bun run check` passes, or the limitation is recorded.
- [ ] `bun run build` passes when packaging or runtime composition changed.

## Documentation

- Documentation impact:
- Companion documentation PR or reason none:

<!-- Record every applicable result. `not-applicable` is exclusive.
     public-code-adjacent-update | private-update-required |
     private-verify-unaffected | private-verification-unavailable |
     not-applicable -->

- [ ] `CURRENT-STATE.md` reflects only behavior supported by this change.
- [ ] Affected public documentation owners were updated or verified unaffected.
- [ ] Any private update or unavailable verification is identified without exposing private content.
- [ ] Required application and documentation pull requests use reciprocal links and the same delivery owner.
- [ ] Public claims are source-verified; no roadmap, unannounced capability, private research, or internal design was added.
- [ ] Existing public documentation was updated instead of creating a duplicate owner.
- [ ] Repository-qualified paths and GitHub links are shareable; no private or contributor-specific local path is persisted.

## Risk and limitations

<!-- Include platform, security, privacy, data, compatibility, or remaining-work limits. -->

## Delivery checklist

<!-- The optional maintainer modes add delivery orchestration. Every PR still
     needs Target, Scope, Validation, and Documentation. Automation applies one
     `size: *` label from changed lines; split an XL PR when practical. -->

- [ ] The target is one Ready, unblocked PR-sized issue.
- [ ] The issue is assigned and **In Progress**.
- [ ] Its parent is **In Progress** when this is the first required child to begin.
- [ ] The branch targets the current default branch and contains no unrelated work.
- [ ] Any parent remains open and **In Progress** for integrated verification.
- [ ] The PR title is a clean conventional subject suitable for squash merge.
- [ ] The squash commit is subject-only by default; any body is limited to one useful short issue-reference footer.
- [ ] Validation, risks, documentation impact, delivery details, and incremental messages remain in this PR rather than the squash commit.
- [ ] Verify records documentation impact and confirms public docs contain only source-verified behavior.
- [ ] Verify identifies available local checkouts and previews safe post-merge default-branch synchronization.
