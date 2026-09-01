# Review

Use `Review — Target: PR #N` to assess a pull request before or alongside
Verify. It is read-only: do not comment, approve, merge, change
labels or Project state, edit files, create a branch, or start delivery.

Load `change-review` for the portable review procedure, `gh-cli` for GitHub PR
state, and the relevant stack skill for changed code. Read the Review section
of the canonical Development contract first, then apply Falryn-specific scope:

1. Resolve the exact repository, PR, base and head SHA, author, linked issue,
   and current check state. Do not review a stale local branch as though it
   were the PR head.
2. Read the complete diff and report every added, modified, deleted, and
   renamed file. Group files by product area and distinguish production code,
   tests, configuration or generated assets, and documentation.
3. Explain the observable behavior or contract changed by the diff. Read the
   modified symbols and the relevant callers, owners, schemas, configuration,
   persistence, wire formats, UI projections, and documentation rather than
   inferring effects from filenames alone.
4. Apply a blast-radius lens: identify the one factual condition most important
   to the change's safety; trace where it could fail beyond the diff; and list
   only concrete risks with a file and line, likelihood, impact, and cheapest
   check. Keep separately the risks that were examined and cleared.
5. Use the PR's observed CI and review state as evidence. Do not check out or
   execute an untrusted pull-request head in a maintainer environment. If the
   central safety condition needs active proof, name the smallest focused test
   or reproduction; run it only when the user explicitly authorizes execution
   in an appropriate isolated environment. Otherwise mark the fact unproven.
6. Report actionable findings only. A finding names the exact changed or
   affected path and line, explains the failure path, and gives a focused
   correction. Do not manufacture concerns or treat style preferences as bugs.

The report includes: exact PR and revision; a complete changed-file inventory;
what changed; the important safety condition and evidence level; findings in
severity order; cleared risks; check evidence and gaps; documentation impact;
and the cheapest pre-merge validation. Finish with one exact Suggested next
prompt from refreshed state. Review may recommend `Implement` or `Verify`, but
never starts, approves, merges, or authorizes another action.

Read [Reporting](reporting.md) for the final report form.
