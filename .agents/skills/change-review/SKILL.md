---
name: change-review
description: Review a local diff, branch or pull request for consequential defects and explain changed behavior. Use for reviews and change walkthroughs; read-only unless the user separately requests repairs or posting.
---

# Change review

Own the reasoning about a change and its evidence. Use the relevant stack skill
for language or framework correctness, `gh-cli` for GitHub evidence and submission,
and `git-workflow` for local Git mutations. General engineering guidance informs
design judgment; this skill adds revision-specific assessment.

## Establish the requested assessment

A walkthrough explains changed behavior and its implications. A review seeks
consequential defects. Neither silently turns into implementation, posting,
approval, merging or metadata maintenance. Preserve any explicitly authorized
additional scope without treating the review alone as that authority.

Resolve the comparison before drawing conclusions:

- Local work: staged, unstaged and relevant untracked files against `HEAD`.
- Branch: merge-base comparison with the requested or resolved target branch.
- PR: repository, base/head SHAs, complete diff, description and linked acceptance.

Record the revision and any inaccessible or omitted material. Do not call a local
branch the PR head without verifying it. Read repository review requirements.

## Follow behavior beyond the diff

Read the intended outcome, complete change and relevant tests. Inventory changed
files internally, including deletions, generated output and configuration. Trace
affected consumers, contracts, state transitions and failure paths. Use the stack
reference that owns the actual risk instead of loading every checklist.

Choose the critical invariants from the change. There may be one or several;
do not manufacture a single safety question for unrelated changes. Check input
boundaries, ordering, cleanup, compatibility, privacy and performance where the
changed behavior makes them relevant. Challenge complexity through concrete
consequences such as duplicate state or hidden ownership, not stylistic preference.

Distinguish direct execution, a source-based failure trace and an untested
hypothesis. Source can establish a defect without executing it. Run a focused
reproduction when it would resolve material uncertainty and the environment is
suitable. A local review may include safe local checks. Untrusted code requires
an isolated environment with no privileged credentials or effects; if that cannot
be established within scope, report the evidence gap.

## Report for the reader

Follow an explicit user or repository format. Otherwise lead a review with
findings ordered by consequence. Each finding needs a precise location, trigger,
user or system impact and enough evidence to assess it. Suggest a focused
correction without implementing it. Keep uncertain risks distinct from defects;
do not invent findings or padding to fill severity categories.

For a clean review, say "No findings" and give the scope, relevant checks and
material gaps. Include revision identity when needed to reproduce the assessment.
A small review can be a few sentences. Large changes may benefit from grouped
behavior and validation notes; a full file inventory is not a mandatory report.

For a walkthrough, lead with what changed and why, then explain the consequential
paths. Do not force it into a defect report. Explain limits without implying
that unexamined behavior was verified.

A changed revision requires reassessment of the resulting diff. Reuse unaffected
analysis and still-applicable checks, inspect new and interacting changes, and
record the new boundary. Review evidence never authorizes a merge or submission.
