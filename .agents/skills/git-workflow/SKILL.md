---
name: git-workflow
description: Repository-agnostic Git work for checkout state, staging, commits, branches, worktrees, remotes, synchronization, patches, merges, rebases, recovery, maintenance, and tags. Use for local Git or ref mutations, not forge records.
---

# Git workflow

Use this skill whenever Git changes a working tree, index, object database, configuration, or ref. Add `gh-cli` only when the verified remote host is GitHub. Repository guidance overrides this generic process.

This bundle was last audited on 2026-09-03 against upstream Git 2.55.0 and behaviorally exercised with Apple Git 2.50.1. Treat that as a maintenance marker, not a compatibility promise. The installed Git, repository format, extensions, and version-matched official documentation own exact syntax and capability.

## Portability contract

This is a global skill, not a policy file for one repository or project. Discover the current repository's remote names, default and protected branches, contribution rules, commit and tag conventions, hooks, signing requirements, pull strategy, validation commands, worktree layout, and release process each time. Examples use placeholders or common names only to show command shape. They do not establish defaults. Never carry a resolved path, ref, remote, identity, credential context, or policy from one repository into another.

## Invariants

1. Resolve an existing checkout before mutating it:
   ```bash
   git status --short --branch
   git remote -v
   git worktree list
   ```
   For initialization or clone work, resolve and inspect the destination instead, then follow [repository-layout.md](reference/repository-layout.md).
2. Read repository `AGENTS.md`, `CONTRIBUTING.md`, hooks, attributes, and observed conventions before choosing a flow.
3. Resolve every branch, remote, base, and path explicitly. Do not assume `origin`, `main`, the current branch, or one checkout per repository.
4. Inspect `git diff` and `git diff --cached`. Preserve unrelated changes and stage only intended paths; never hide them in a stash, commit, reset, or clean operation.
5. Stop on a dirty tree you did not create, unknown worktree, detached HEAD, conflict, rejected push, failing hook, or in-progress operation. Do not auto-resolve or initialize a repository uninvited.
6. Never bypass hooks with `--no-verify`, signing with `--no-gpg-sign`, or policy with a force flag.
7. Never commit secrets, credential files, private keys, service-account data, or password-bearing connection strings. Treat committed secrets as leaked; rotate before any authorized history repair.
8. Confirm before every history rewrite (`commit --amend`, rebase, squash, filter), force-push, hard reset, destructive clean, branch/tag deletion, tag move, object pruning, or other hard-to-recover ref or object change, even when commits are not published.
9. Force-push only after creating a backup ref and only with the exact lease form `--force-with-lease=<branch>:<expected-old-sha>`. Never use bare `--force` or bare `--force-with-lease`.
10. After mutation, re-read the affected state. Report old and new SHAs, validation, skipped work, and a safe undo path when one exists.

## Route one primary guide

| Intent | Guide |
| --- | --- |
| Initialize, clone, change remotes, use sparse/partial clones, submodules, or LFS | [repository-layout.md](reference/repository-layout.md) |
| Stage or commit | [commit.md](reference/commit.md) |
| Branch create, switch, or delete | [branch.md](reference/branch.md) |
| Create, move, lock, repair, or remove a linked worktree | [worktree.md](reference/worktree.md) |
| Fetch, pull, rebase, or push | [sync.md](reference/sync.md) |
| Synchronize default checkouts after delivery | [delivery-checkout.md](reference/delivery-checkout.md) |
| Local merge | [merge.md](reference/merge.md) |
| Restore, reset, revert, clean, or manage a stash | [undo.md](reference/undo.md) |
| Cherry-pick, apply, or exchange patches | [patches.md](reference/patches.md) |
| Amend, rebase, squash, rewrite, or force-push | [rewrite.md](reference/rewrite.md) |
| Recover lost or overwritten work | [recover.md](reference/recover.md) |
| Find the introducing commit | [bisect.md](reference/bisect.md) |
| Secret/history/size audit | [audit.md](reference/audit.md) |
| Configure Git, ignore rules, attributes, hooks, credentials, or signing | [configuration.md](reference/configuration.md) |
| Diagnose repository health or run maintenance, fsck, gc, prune, or bundles | [maintenance.md](reference/maintenance.md) |
| Create or move a Git tag | [release.md](reference/release.md) |
| Subject, branch, and tag conventions | [conventions.md](reference/conventions.md) |

Open a second guide only when the task truly crosses boundaries. After a GitHub merge, use `gh-cli` for remote issue/Project reconciliation and [delivery-checkout.md](reference/delivery-checkout.md) for local synchronization.

For an uncommon porcelain or plumbing command not listed here, identify which Git layer it changes, read the installed help and current official documentation, and preserve these invariants. Do not use low-level ref or object commands merely to bypass a porcelain safety check.

## Ownership boundaries

| Operation | Owner |
| --- | --- |
| status, diff, log, blame | answer directly; no skill mutation flow needed |
| repository setup, worktree, stage, commit, rebase, tag, push, recovery | `git-workflow` |
| GitHub issues, PRs, checks, merge, Projects | `gh-cli` |
| non-GitHub forge operations | the matching forge process, not `gh-cli` |

A remote alias is not a forge identity. Inspect its URL. Never use `gh` against GitLab, Bitbucket, Azure Repos, or an ambiguous host.

## Commit policy

The fallback subject and naming guidance lives in
[conventions.md](reference/conventions.md). Repository and active user policy
choose message bodies, trailers, signing, and automatic commit behavior. If no
active authoritative policy enables unprompted commits, report the clean boundary
and suggest a subject instead. Automatic commit policy never authorizes push,
rewrite, merge, deletion, or another separately confirmed action.

## Exact syntax and compatibility

Use the installed Git, not remembered flag tables:

```bash
git --version --build-options
git help <command>
git <command> -h
```

Prefer stable porcelain. Check help before using a recent option, and provide a supported fallback instead of silently changing semantics. Never parse human-oriented output when a documented machine format such as `--format`, `-z`, or an explicit plumbing command exists.

## Evidence after mutation

Re-read status, branch/upstream, and affected refs. For a commit, verify the exact staged tree and resulting SHA. For push or rewrite, verify the remote tracking state and lease result. For recovery, preserve the source evidence until the user confirms the restored result.
