# issues

Create and maintain Issues as repository-owned work records. Preserve native hierarchy and dependency relationships.

## Inspect taxonomy and conventions

```bash
gh issue list --repo OWNER/REPO --state all --limit 100 \
  --json number,title,state,labels,milestone,assignees,parent
gh label list --repo OWNER/REPO --limit 100
gh api repos/OWNER/REPO/milestones?state=all
find .github/ISSUE_TEMPLATE -maxdepth 2 -type f 2>/dev/null
```

Read `CONTRIBUTING.md`, issue forms, templates, and existing examples before inventing labels or body structure.

## Choose the right object

- Milestone: repository-scoped release or outcome.
- Parent issue: cohesive outcome with cross-child acceptance.
- Native subissue: one independently reviewable slice.
- Checklist: steps smaller than a pull request.
- Blocking relationship: actual dependency.
- Label: orthogonal classification such as type, area, priority, or triage.
- Project field: cross-repository workflow state, priority, iteration, or ownership.

Avoid phase/subphase label trees, duplicated subissue checklists, and labels that mirror milestones or Project fields.

## Create and edit

```bash
gh issue create --repo OWNER/REPO \
  --title "Implement bounded export" \
  --body-file - \
  --label "type: feature" \
  --milestone "v0.3"

gh issue edit 123 --repo OWNER/REPO \
  --add-label "area: data" \
  --milestone "v0.3"
```

Use `--template`, `--assignee`, `--type`, and `--project` only when the repository supports them. Supply multiline Markdown through a validated body file or validated stdin artifact, not an interpolated shell string.

Before replacing an existing body, retain the pre-image, render and inspect the full candidate, then re-read the issue after writing. Never pipe an unchecked transform into `gh issue edit --body-file -`; follow [Remote body and metadata safety](../SKILL.md#remote-body-and-metadata-safety).

## Native hierarchy and dependencies

Current CLI versions support:

```bash
gh issue create --repo OWNER/REPO --parent 100 ...
gh issue edit 123 --repo OWNER/REPO --parent 100
gh issue edit 100 --repo OWNER/REPO --add-sub-issue 123
gh issue edit 123 --repo OWNER/REPO --add-blocked-by 120
gh issue edit 123 --repo OWNER/REPO --add-blocking 140
gh issue view 100 --repo OWNER/REPO \
  --json parent,subIssues,subIssuesSummary
```

Use native relationships, not `Parent: #100` prose as a substitute. Check the installed command's `--help` because these flags are version-sensitive. GitHub limits parent size and nesting depth; inspect current official limits before creating large hierarchies.

## Body quality

An implementation issue should name:

- outcome and owner boundary;
- dependencies and non-goals;
- contract, lifecycle, failure, cancellation, limits, safety/privacy, projections, and recovery;
- ordered tasks and independently verifiable acceptance;
- canonical design or user documentation;
- completion proof.

A parent issue owns integration, shared failures, and final acceptance. It should not duplicate every child checklist.

## Triage and lifecycle

```bash
gh issue status --repo OWNER/REPO
gh issue comment 123 --repo OWNER/REPO --body-file -
gh issue close 123 --repo OWNER/REPO --reason completed
gh issue close 123 --repo OWNER/REPO --reason "not planned"
gh issue reopen 123 --repo OWNER/REPO
gh issue transfer 123 NEW-OWNER/NEW-REPO --repo OWNER/REPO
gh issue lock 123 --repo OWNER/REPO --reason spam
gh issue pin 123 --repo OWNER/REPO
```

Closing, locking, pinning, transferring, deleting, or bulk-changing issues requires exact targets and post-write verification. Transfer can break repository-scoped milestones, labels, links, and automation; inspect both sides first.

Use `duplicate`, `not planned`, and completion reasons truthfully. Never close an issue merely because its milestone moved or its Project item was archived.

Comments, reactions, events, and timeline items are distinct records. Use `gh issue comment` for discussion; use documented API endpoints for reactions or timeline inspection. Editing another person's content, deleting comments, or mass-reacting is socially consequential and requires exact authorization.

## Labels and milestones

```bash
gh label create "area: runtime" --repo OWNER/REPO --color 5319E7 \
  --description "Runtime and lifecycle"
gh label edit "area: runtime" --repo OWNER/REPO --color 6F42C1
gh label clone SOURCE/REPO --repo OWNER/REPO
```

Milestones use the REST API when dedicated CLI support is absent:

```bash
gh api repos/OWNER/REPO/milestones --paginate
gh api repos/OWNER/REPO/milestones -X POST \
  -f title='v0.3' -f description='Release outcome'
```

Resolve milestone numbers before updates. Never infer that equal titles across repositories share identity.

## Bulk safety and audit

Before a batch, compute the exact existing set and duplicates. Make creation repeat-safe using stable titles within a known parent or another declared identity. Run separate passes for:

1. create/update issues;
2. attach parent/dependency relationships;
3. assign milestones/labels/Projects;
4. close or archive obsolete work;
5. audit counts, duplicates, orphans, missing fields, and body markers.

Report partial failures by issue number. Do not rerun a create pass unchanged after uncertain output.
