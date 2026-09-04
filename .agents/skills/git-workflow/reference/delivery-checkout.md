# Delivery checkout

Synchronize local Git checkouts only after remote delivery succeeds. GitHub issue and Project reconciliation belongs to `gh-cli`; remote merge order belongs to that delivery contract.

## Procedure

For each checkout, follow [the default-checkout synchronization procedure](sync.md#synchronize-the-default-checkout-after-merge). Do not duplicate or reorder those safeguards here.

Apply it only when the checkout is clean, attached, and free of an in-progress Git operation. A dirty, divergent, detached, conflicted, or worktree-locked checkout is a stop condition, not permission to stash, reset, rebase, discard, or force.

For multiple repositories, derive local iteration order from the completed delivery bundle rather than assuming documentation-first or application-first. Synchronize each available clean checkout independently and preserve any checkout that cannot safely fast-forward.

Branch deletion remains a separately confirmed destructive action. Continuing another slice uses a fresh issue-linked branch from the updated default branch rather than a merged branch.

## Report

For every checkout, report:

- path and default branch;
- local and remote SHA;
- upstream and cleanliness;
- synchronized, skipped, or blocked state with reason;
- any branch intentionally retained.
