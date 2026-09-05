# Contributor readiness

Falryn currently limits issues and pull requests to collaborators while its
foundation changes quickly. The repository already contains the public process
and controls needed for outside contributions. [DEVELOPMENT.md](DEVELOPMENT.md)
owns the contributor workflow; this file records the remaining repository
administration boundary.

## Opening contributions

When the public contracts are stable, remove the GitHub interaction restriction
for the repository or organization. Do not weaken `main` at the same time.
Keep these safeguards:

1. require pull requests and linear history on `main`;
2. block force pushes and branch deletion;
3. require every job in `.github/workflows/ci.yml` and the **Validate
   contribution metadata** check;
4. require conversation resolution; and
5. require one approval and CODEOWNERS review only after a second maintainer can
   satisfy those rules independently.

A sole maintainer must not enable a rule that no eligible reviewer can satisfy.
The interaction restriction is the only planned switch for accepting outside
issues and pull requests.

## Enforcement scope

Repository rulesets and contribution-policy checks apply to organization
members, collaborators, maintainers, and future outside contributors. The
repository owner's exact account is the only `always` bypass actor on protected
branches and release tags.

That exception preserves emergency and solo-maintenance access. It does not
turn an informational `size:*`, `area:*`, or `vouch:*` label into correctness or
merge evidence.

## Triage contract

Public contribution and private product planning are independent:

| Actor | Responsibility |
| --- | --- |
| Contributor | Choose Feature, Bug report, or Work item; complete the public outcome, baseline or reproduction, scope, dependencies, proof, documentation impact, and Contribution checklist. |
| Repository automation | Map the declared work type and primary area to canonical labels, then report only missing public contribution evidence. |
| Maintainer | Review the contribution on its public merits. Separately decide whether to adopt it into the private product-development Roadmap. |

A contribution issue may remain unassigned, have no milestone, and have no
private Project item. That is valid. Contributors do not supply or wait for
Status, Priority, or Readiness. For a large or direction-setting change, wait
for a maintainer to confirm public scope before spending substantial effort.

Every contribution issue must remain useful without Falryn Docs or private
Roadmap access. Before a non-draft pull request, its public body names:

- the observed source baseline and remaining outcome;
- scope and relevant non-goals;
- inputs, outputs, state, effects, limits, failures, cancellation, cleanup, and
  recovery that apply to the slice;
- the real product composition point;
- focused validation and completion proof; and
- documentation impact using the results in [DEVELOPMENT.md](DEVELOPMENT.md).

Repository automation requires one work-type label and at least one area label.
The issue form and `issue-governance.yml` expose these requirements. `Feature`
and `Bug report` apply their work type directly. The
general `Work item` form covers documentation, infrastructure and maintenance,
and research or qualification; repository automation maps its declared work
type and every form's primary area to canonical labels.

The maintainer-applied `roadmap` label selects the maintainer issue format in
both issue and PR checks. These issues need Outcome and Completion proof rather
than the public form's exact section names. Before a delivery PR, the Ready
checklist must be non-empty and fully checked; an adopted public contribution
may retain its Contribution checklist. Classification, open-leaf, and native
blocker checks still apply. Author identity, body text, and the identity of the
person editing an issue do not select this format. The label does not establish
private Project membership or verified readiness.

Issue automation reads the current issue before validating it. It updates its
own reminder only when the diagnostic text changes and removes that reminder
when the selected contract passes. It does not modify human comments.

If a maintainer adopts an issue into product development, Project membership
becomes the private ownership marker. Only then do the sole assignee, milestone,
Status, P0-P3 Priority, Readiness, native hierarchy, liveness, and deterministic
sequence rules apply. The maintainer workflow lives in the vendored
[Roadmap field guide](.agents/skills/falryn-workflow/references/roadmap-fields.md).
It must not leak into the public contribution check.

Audit snapshots may contain issue bodies and private Project metadata. They stay
outside both repositories and never enter public reports. An unavailable private
audit is reported as unavailable, not reconstructed from labels, milestones,
issue numbers, recency, or board position.

## Pull-request controls

Every non-Dependabot pull request closes exactly one PR-sized owning issue and retains the required
target, scope, validation, documentation, and risk sections. Automation then:

- checks the conventional title, exactly one primary change class, concrete
  section evidence, and valid documentation-impact results;
- verifies the owning issue is open, publicly complete, PR-sized, and free of
  open native blockers;
- applies changed-file area labels and exactly one `size:*` label;
- records the author's `vouch:*` trust classification; and
- runs the multi-platform source and compiled validation in `ci.yml`.

An XL label is a review signal, not an automatic rejection. Split a change when
each part can remain independently useful and verifiable. The vouch list records
maintainer trust decisions only. It never grants merge permission or bypasses a
required check.

The same policy checks run for the owner, organization members, collaborators,
and future outside contributors. Only Dependabot uses its dedicated metadata
path.

## Final opening check

Before removing the interaction restriction, verify the issue forms, pull
request template, CODEOWNERS, security reporting, Dependabot, rulesets, required
checks, and workflow permissions against the live repository. Open one test
issue and pull request through a non-owner account. Confirm that the contributor
can complete the public path without private access and that a maintainer can
reconcile the private path without exposing it.
