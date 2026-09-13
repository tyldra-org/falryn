# Govern selected work

Project membership is deliberate maintainer adoption. The public `roadmap` label
selects an issue-body format; it proves neither membership nor readiness. An
ordinary contribution outside the Project needs no assignee, release or private
field. Applying a work-type label does not adopt it.

## Keep facts with their owners

| Fact | Authority |
| --- | --- |
| Scope, acceptance, baseline and completion proof | Owning issue and source evidence |
| Parent/child and blocked-by relationships | Native GitHub relationships |
| Status, Priority, Readiness, release and ordering | Private Project plus repository auditors |
| Exact option names, descriptions, colors and enabled workflow names | `tools/governance/roadmap-governance/contracts.ts` |
| Release validation, dependency ordering and liveness decisions | `tools/governance/roadmap-governance.ts` and its parser |

Read the source constants before field maintenance. Do not duplicate their exact
catalog in this skill or change live values ahead of the published auditor.
The issue and PR contribution checks remain public and independent of Project
access. Retaining a Contribution checklist can satisfy the public PR check;
Roadmap Ready still requires the auditor's fully checked Ready checklist.

## Reconcile transitions

| Event | Result |
| --- | --- |
| Adopt an open leaf | Todo, P2 unless justified otherwise, Needs Planning |
| Missing derivable contract facts | Todo, Needs Planning |
| Required human choice | Todo, Needs Decision with `Decision required: @owner — question` |
| Decision recorded | Needs Planning until the remaining contract is verified |
| Current complete leaf contract | Ready; open blockers still prevent implementation |
| Implementation admitted and starts | In Progress, Ready, authenticated sole assignee |
| Open blocker appears | Todo; preserve still-valid planning evidence |
| Open parent | Parent readiness and valid Todo/In Progress status; no parent implementation |
| Fully proven issue closes | Done, Historical readiness; retain real priority |
| Incomplete issue reopens | Todo, Needs Planning, then verify again |

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

## Keep release scheduling private

Target release is the Project's ordered single-select field. Adopted open issues
need an existing OPEN option. Option descriptions start with `State: OPEN` or
`State: CLOSED`; the source validates the catalog and its limits. Never encode
its private names or order in public issues, PRs, labels, fixtures or milestones.

Children normally share their parent's release. An intentionally earlier child
uses the private Release exception field with the source-enforced form:

```text
early-prerequisite-v1; parent <owner/repository>#<N>; child <exact child release>; parent <exact parent release>.
```

Verify both selections and ordering whenever parent, release or catalog order
changes. Cross-release blockers independently take precedence over scheduling.
A scheduling-only change does not require rewriting public implementation scope.
Resolve legacy Milestone requests to the private field, never recreate milestones.

## Change records and automation

Before mutation, capture the exact private preimage, validate the full candidate,
re-read the target and apply only the intended change. Use one Project field per
command. Verify each result; on an uncertain effect inspect before retrying.
Bound bulk work and report partial results per object. Follow [audit refresh](audits.md).

Keep source-required Project workflows enabled. Do not broadly auto-adopt all
repository issues. Inspect workflow filters, field effects and views after
maintenance because the API only proves part of that configuration.

For migrations, deploy compatible schema, tooling and guidance before retiring
old authority. Preserve history, exceptions, assignments and unrelated fields;
verify values and intended ordering before cutover. Keep receipts of partial
writes privately. Run both live audits afterward. Do not rewrite Git history or
claim that previously public copies have become private.
