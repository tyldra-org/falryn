# Reporting

Every maintainer-mode report states the resolved target, GitHub/Project changes,
validation actually performed, and unresolved blockers or limitations. Finish
with one exact, copy-ready line:

~~~text
Suggested next prompt: Implement — Target: Issue #42
~~~

Choose it only after re-reading the current hierarchy, dependencies, Project
state, PR/check state, documentation, and CURRENT-STATE.md. Use exact numbers
or titles—never placeholders. A suggested prompt is navigation, not
authorization.

Deliver and Next may suggest only:

~~~text
Suggested next prompt: Deliver — Target: Issue #42
Suggested next prompt: Deliver — Target: Parent issue #41
Suggested next prompt: Deliver — Target: Parent chain #41
Suggested next prompt: none
~~~

Parent chain is resume-only when the host interrupted an active chain. While
that chain has remaining siblings and the host has not cut the turn, do not end
with a prompt; continue the next child.

When naming a repository file in a report, group its local absolute path,
repository-qualified path, and GitHub link at the relevant revision. Never
persist a user-specific local path in source, documentation, an issue, a PR, or
Project metadata. Link GitHub objects directly instead of inventing file paths.
