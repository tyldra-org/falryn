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

Issue creation deliberately separates accessible contributor work from
maintainer scheduling:

| Actor | Responsibility |
| --- | --- |
| Contributor | Choose Feature, Bug report, or Work item; complete the public outcome, baseline or reproduction, scope, boundaries, dependencies, proof, documentation impact, relationship, and Ready checklist. |
| Repository automation | Map the declared general work type and primary area to canonical labels, then report incomplete public evidence separately from maintainer triage. |
| Maintainer | Assign the sole owner and milestone, verify native relationships, and reconcile the private Roadmap item, Status, Priority, and Readiness. |

A contributor is never expected to edit the private Project or assign metadata
their repository permission does not expose. Once the public contract is
complete, they wait for maintainer triage before implementation or a non-draft
pull request. The public field guide explains each private value so the handoff
is predictable, not so contributors must mutate it.

Every public issue must remain useful without Falryn Docs or private Roadmap
access. Before a maintainer marks a PR-sized issue Ready, its public body names:

- the observed source baseline and remaining outcome;
- scope, non-goals, owner boundaries, and native relationships;
- inputs, outputs, state, effects, limits, failures, cancellation, cleanup, and
  recovery that apply to the slice;
- the real product composition point;
- focused validation and completion proof; and
- documentation impact using the results in [DEVELOPMENT.md](DEVELOPMENT.md).

Repository-visible triage also assigns exactly one owner, one milestone, one
work-type label, at least one area label, and a native parent or explicit
Standalone relationship. The issue form and `issue-governance.yml` expose these
requirements. `Feature` and `Bug report` apply their work type directly. The
general `Work item` form covers documentation, infrastructure and maintenance,
and research or qualification; repository automation maps its declared work
type and every form's primary area to canonical labels. Native GitHub
relationships remain authoritative over prose.

Authenticated maintainers additionally reconcile the private Roadmap's Status,
Priority, Readiness, liveness, and sequence fields. Those fields cannot replace
the public handoff and are not a contributor prerequisite. New open leaves
start as **Todo**, **P2**, and **Needs Planning**. **Ready** means the current
PR-sized contract is verified, **Needs Decision** names a human choice in the
public issue, **Parent** is an open native parent, and **Historical** readiness
is closed-only. Priority remains P0 emergency, P1 high, P2 normal, or P3 low;
it does not encode blockers or work type. The exact option descriptions,
transitions, and Project automation contract live in the vendored
[Roadmap field guide](.agents/skills/falryn-workflow/references/roadmap-fields.md),
and the [governance audit guide](.agents/skills/falryn-workflow/references/governance-audits.md)
owns verification.

Audit snapshots may contain issue bodies and private Project metadata. They stay
outside both repositories and never enter public reports. An unavailable private
audit is reported as unavailable, not reconstructed from labels, milestones,
issue numbers, recency, or board position.

## Pull-request controls

Every non-Dependabot pull request closes exactly one PR-sized owning issue and retains the required
target, scope, validation, documentation, and risk sections. Automation then:

- checks the conventional title, exactly one primary change class, concrete
  section evidence, and valid documentation-impact results;
- verifies the owning issue is open, metadata-complete, a Ready PR-sized leaf,
  and free of open native blockers;
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
