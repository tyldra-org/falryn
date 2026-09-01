# Reporting

Every maintainer-mode and read-only project-orientation report states the
resolved target or observed frontier, GitHub/Project changes (or that none were
made), validation actually performed, and unresolved blockers or limitations.
Finish with one exact, copy-ready line:

~~~text
Suggested next prompt: Implement — Target: Issue #42
~~~

Choose it only after re-reading the current `gh` authenticated identity, the
selected issue's sole assignee, hierarchy, dependencies, Project state,
PR/check state, documentation, and CURRENT-STATE.md. Never carry an assignee or
account name forward from an older report. Use exact numbers or titles, never
placeholders. A suggested prompt is navigation, not authorization.

A Review report additionally inventories every added, modified, deleted, and
renamed file; separates findings from cleared risks; and states whether its key
blast-radius safety fact was proven by observed evidence or remains unproven.

Deliver and Next may suggest only:

~~~text
Suggested next prompt: Deliver — Target: Issue #42
Suggested next prompt: Deliver — Target: Parent issue #41
Suggested next prompt: Deliver — Target: Parent chain #41
Suggested next prompt: Ask @owner to run Deliver — Target: Issue #42
Suggested next prompt: Assign Issue #42 to @authenticated-account, then run Deliver — Target: Issue #42
Suggested next prompt: none
~~~

Use the direct Deliver forms only when the selected issue or eligible child is
sole-assigned to the active authenticated account. Use the `Ask` form when a
different account owns it. Use the `Assign` form when it is unassigned and the
active account is the intended owner; this is a suggestion, not authority to
change the assignee. After a delivery closes, re-run Next against live state
instead of repeating the completed issue as the suggestion.

Parent chain is resume-only when the host interrupted an active chain. While
that chain has remaining siblings and the host has not cut the turn, do not end
with a prompt; continue the next child.

When naming a repository file in a report, group its local absolute path,
repository-qualified path, and GitHub link at the relevant revision. Never
persist a user-specific local path in source, documentation, an issue, a PR, or
Project metadata. Link GitHub objects directly instead of inventing file paths.
