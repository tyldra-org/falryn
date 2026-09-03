---
name: git-workflow
description: Git process and safety for commits, branches, fetch/push, rebases, local merges, rewrites, recovery, bisect, tags, and delivery-checkout synchronization. Does not cover GitHub platform operations.
---

# Git workflow

Use this skill whenever local Git state or history changes. Add `gh-cli` only when the verified remote host is GitHub. Repository guidance overrides this generic process.

## Invariants

1. Resolve the checkout before mutating it:
   ```bash
   git status --short --branch
   git remote -v
   ```
2. Read repository `AGENTS.md`, `CONTRIBUTING.md`, hooks, and conventions before choosing a flow.
3. Inspect `git diff` and `git diff --cached`. Stage only intended paths; never sweep unrelated changes with `git add -A`.
4. Stop on a dirty tree you did not create, unknown worktree, detached HEAD, conflict, rejected push, or failing hook. Do not auto-resolve or initialize a repository uninvited.
5. Never bypass hooks with `--no-verify`.
6. Never commit secrets, credential files, private keys, service-account data, or password-bearing connection strings. Treat committed secrets as leaked; rotate before any authorized history repair.
7. Confirm before every history rewrite (`commit --amend`, rebase, squash, filter), force-push, hard reset, destructive clean, branch/tag deletion, tag move, or other irreversible ref change—even when commits are not published.
8. Force-push only after creating a backup ref and only with the exact lease form `--force-with-lease=<branch>:<expected-old-sha>`. Never use bare `--force` or bare `--force-with-lease`.
9. After ref changes, report old and new SHAs, skipped work, and a safe undo path when one exists.

## Route one primary guide

| Intent | Guide |
| --- | --- |
| Stage or commit | [commit.md](reference/commit.md) |
| Branch create, switch, or delete | [branch.md](reference/branch.md) |
| Fetch, pull, rebase, or push | [sync.md](reference/sync.md) |
| Synchronize default checkouts after delivery | [delivery-checkout.md](reference/delivery-checkout.md) |
| Local merge | [merge.md](reference/merge.md) |
| Amend, rebase, squash, rewrite, or force-push | [rewrite.md](reference/rewrite.md) |
| Recover lost or overwritten work | [recover.md](reference/recover.md) |
| Find the introducing commit | [bisect.md](reference/bisect.md) |
| Secret/history/size audit | [audit.md](reference/audit.md) |
| Create or move a Git tag | [release.md](reference/release.md) |
| Subject, branch, and tag conventions | [conventions.md](reference/conventions.md) |

Open a second guide only when the task truly crosses boundaries. After a GitHub merge, use `gh-cli` for remote issue/Project reconciliation and [delivery-checkout.md](reference/delivery-checkout.md) for local synchronization.

## Ownership boundaries

| Operation | Owner |
| --- | --- |
| status, diff, log, blame | answer directly; no skill mutation flow needed |
| branch, stage, commit, rebase, tag, push, recovery | `git-workflow` |
| GitHub issues, PRs, checks, merge, Projects | `gh-cli` |
| non-GitHub forge operations | the matching forge process, not `gh-cli` |

A remote alias is not a forge identity. Inspect its URL. Never use `gh` against GitLab, Bitbucket, Azure Repos, or an ambiguous host.

## Commit policy

The fallback subject and naming guidance lives in
[conventions.md](reference/conventions.md). Repository and active user policy
choose message bodies, trailers, signing, and automatic commit behavior. If no
authoritative policy enables unprompted commits, report the clean boundary and
suggest a subject instead. Automatic commit policy never authorizes push,
rewrite, merge, deletion, or another separately confirmed action.

## Evidence after mutation

Re-read status, branch/upstream, and affected refs. For a commit, verify the exact staged tree and resulting SHA. For push or rewrite, verify the remote tracking state and lease result. For recovery, preserve the source evidence until the user confirms the restored result.
