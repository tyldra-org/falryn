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
requirements. Native GitHub relationships remain authoritative over prose.

Authenticated maintainers additionally reconcile the private Roadmap's Status,
Priority, Readiness, liveness, and sequence fields. Those fields cannot replace
the public handoff and are not a contributor prerequisite. Their policy remains
private; the public repository contains the executable access and audit contract
in the vendored
[governance audit guide](.agents/skills/falryn-workflow/references/governance-audits.md).

Audit snapshots may contain issue bodies and private Project metadata. They stay
outside both repositories and never enter public reports. An unavailable private
audit is reported as unavailable, not reconstructed from labels, milestones,
issue numbers, recency, or board position.

## Pull-request controls

Every non-Dependabot pull request links its issue and retains the required
target, scope, validation, documentation, and risk sections. Automation then:

- checks the conventional title and required public context;
- applies changed-file area labels and exactly one `size:*` label;
- records the author's `vouch:*` trust classification; and
- runs the multi-platform source and compiled validation in `ci.yml`.

An XL label is a review signal, not an automatic rejection. Split a change when
each part can remain independently useful and verifiable. The vouch list records
maintainer trust decisions only. It never grants merge permission or bypasses a
required check.

## Final opening check

Before removing the interaction restriction, verify the issue forms, pull
request template, CODEOWNERS, security reporting, Dependabot, rulesets, required
checks, and workflow permissions against the live repository. Open one test
issue and pull request through a non-owner account. Confirm that the contributor
can complete the public path without private access and that a maintainer can
reconcile the private path without exposing it.
