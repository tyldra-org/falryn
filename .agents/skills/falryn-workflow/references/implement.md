# Implement

Read the Implement section of the canonical Development contract before acting.

- Accept exactly one Ready, unblocked, PR-sized standalone issue or native
  child. A parent target is not directly implementable; identify its next
  eligible child instead.
- Re-read the issue, parent, blockers, design owners, source, state,
  repository guidance, and required skills. Stop as **Not Ready** rather than
  silently planning while coding.
- Confirm the authenticated GitHub account is the issue's sole assignee, then
  set it **In Progress** before code. Set the parent **In Progress** when this
  is its first active child. Stop and route to the owner when the account does
  not match.
- Continue a valid open delivery branch and PR after a failed Verify; otherwise
  branch from the current default branch using the repository convention.
- Implement the complete scoped outcome, focused tests, the recorded
  documentation impact, and the smallest supported CURRENT-STATE.md update.
  Run applicable repository-owned checks.
- Push only the intended work and update or open one focused delivery PR.
  Include canonical documentation changes for the same issue in that PR; it is
  the sole delivery owner and closes its Falryn issue when appropriate.

Implement never merges. A new head invalidates the prior Verify result, merge
preview, and approval tied to that revision. Follow with a fresh Verify.

For incomplete or merged outcomes, read [Corrections](corrections.md).
