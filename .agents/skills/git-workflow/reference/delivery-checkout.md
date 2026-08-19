# delivery checkout

Synchronize **local git checkouts** after remote work lands. GitHub issue/Project reconcile lives in **gh-cli** → [issue-lifecycle.md](../../gh-cli/process/issue-lifecycle.md). Multi-PR merge order lives in **gh-cli** → [delivery.md](../../gh-cli/process/delivery.md).

## When to use

After:

- a pull request merged on GitHub;
- a multi-repository delivery bundle completed on GitHub;
- the user asks to sync local `main` (or default branch) to remote.

Local sync is **not** a substitute for verifying GitHub issue/Project state. Do both when the workflow includes tracking boards.

## Single repository

Follow [sync.md](sync.md#synchronize-the-default-checkout-after-merge):

1. Inspect cleanliness and in-progress operations (`git status`, no mid-rebase/merge).
2. `git fetch --prune origin`
3. Resolve the remote default branch; verify fast-forward ancestry.
4. `git switch <default>` then `git merge --ff-only origin/<default>`
5. Re-read branch, upstream, SHA, and cleanliness.

If the checkout is dirty, detached, divergent, or locked in another worktree — **stop and report**. Do not stash, reset, or force merely to "look synced."

## Multiple repositories

Repeat the single-repository procedure **per checkout** in the delivery bundle. Order:

1. Complete GitHub reconcile for the whole bundle (**gh-cli**).
2. For each available clean checkout, fast-forward its default branch to the merged remote SHA.
3. Report each checkout's final branch, SHA, and any checkout intentionally left untouched with the reason.

Typical bundle: documentation repository first, application repository second — matching the remote merge order, not reversing it locally.

## Feature branches after merge

Landing on default does **not** authorize deleting the feature branch. Branch deletion is a separate explicit action per [SKILL.md](../SKILL.md#confirm-before).

If continuing serial work on the next sibling, create or switch to a **new issue-linked branch** from the updated default rather than reusing a merged branch name.

## Reporting back

After sync:

- each repository path;
- default branch name;
- local SHA vs `origin/<default>` (should match after ff-only);
- dirty or skipped checkouts and why.
