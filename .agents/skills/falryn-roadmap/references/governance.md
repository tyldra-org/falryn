# Govern selected work

Roadmap membership is deliberate maintainer adoption: an adopted issue carries
the organization-only `Roadmap priority` and `Readiness` issue fields and a
release milestone. The public `roadmap` label selects an issue-body format; it
proves neither membership nor readiness. An ordinary contribution without Roadmap
fields needs no assignee, release or private field. Applying a work-type label
does not adopt it.

## Keep facts with their owners

| Fact | Authority |
| --- | --- |
| Scope, acceptance, baseline and completion proof | Owning issue and source evidence |
| Parent/child and blocked-by relationships | Native GitHub relationships |
| Release and its open or closed state | The issue's milestone in its repository |
| Priority, Readiness and release exception | Organization-only issue fields |
| Status | Derived by the auditor from issue state, closing pull requests and children |
| Exact field names, options, descriptions and colors | `tools/governance/roadmap-governance/contracts.ts` |
| Release validation, dependency ordering and liveness decisions | `tools/governance/roadmap-governance.ts` and its parser |

Read the source constants before field maintenance. Do not duplicate their exact
catalog in this skill or change live values ahead of the published auditor.
The issue and PR contribution checks remain public and independent of the
private fields. Retaining a Contribution checklist can satisfy the public PR
check; Roadmap Ready still requires the auditor's fully checked Ready checklist.

## Reconcile transitions

| Event | Result |
| --- | --- |
| Adopt an open leaf | Roadmap priority P2 unless justified otherwise, Needs Planning, release milestone |
| Missing derivable contract facts | Needs Planning |
| Required human choice | Needs Decision with `Decision required: @owner — question` |
| Decision recorded | Needs Planning until the remaining contract is verified |
| Current complete leaf contract | Ready; open blockers still prevent implementation |
| Implementation admitted | Ready, authenticated sole assignee; opening the closing pull request makes it In Progress |
| Open parent | Parent readiness; no parent implementation or closing pull request |
| Fully proven issue closes | Historical readiness; retain real priority |
| Incomplete issue reopens | Needs Planning, then verify again |

Status needs no update. A leaf is In Progress exactly while it has an open
closing pull request; a closed-unmerged pull request without a replacement is an
abandoned-work diagnostic. A parent is In Progress once any native child has
started.

Priority represents selection urgency. It is independent of severity, work type,
readiness and progress. P0 needs explicit dated approval in the public issue,
using the source-enforced `P0 approval: @owner on YYYY-MM-DD — reason` form.
Historical priority preserves missing old evidence; it is never new/open work's
priority. Needs Decision is reserved for a human choice, not generic blocking.

A parent closes only after integrated acceptance, not merely all child closures.
A closed PR without merge cannot prove delivery. Native dependencies must have
real implementation or completion reasons; do not serialize unrelated work by
inventing blockers. Open related issues needed by the audited graph must also
be adopted, rather than disappearing from ordering.

## Schedule releases

A release is a milestone titled `v<major>.<minor> <name>`, present with the same
title and state in both Roadmap repositories. The auditor orders releases by that
version as a decimal, so `v0.35` falls between `v0.3` and `v0.4`, and a new
release can be inserted by choosing an unused version. Adopted open issues need
an open release. Close a release milestone in both repositories together.
Release names and membership are public.

Children normally share their parent's release. An intentionally earlier child
uses the organization-only `Release exception` field with the source-enforced
form:

```text
early-prerequisite-v1; parent <owner/repository>#<N>; child <exact child release>; parent <exact parent release>.
```

Verify both milestones and ordering whenever parent or release changes.
Cross-release blockers independently take precedence over scheduling. A
scheduling-only change does not require rewriting public implementation scope.

## Change records

Before mutation, capture the exact preimage, validate the full candidate, re-read
the target and apply only the intended change. Change one field or milestone per
command. Verify each result; on an uncertain effect inspect before retrying.
Bound bulk work and report partial results per object. Follow [audit refresh](audits.md).

Planning fields stay organization-only. Never change their visibility or copy
their values into public issues, PRs, labels, fixtures or logs.

