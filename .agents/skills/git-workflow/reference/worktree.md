# Worktrees

Use linked worktrees when branches or revisions must be available at the same time. They share refs and the object database while keeping separate working trees, indexes, `HEAD`s, and in-progress operation state.

## Inspect first

```bash
git worktree list --porcelain
git branch --show-current
git status --short --branch
```

Resolve the common repository, destination path, branch, start point, and whether another worktree already holds that branch. Inspect the destination itself. Do not place a worktree over user files or inside another worktree.

## Create

Create a new branch from an explicit current base:

```bash
git fetch <remote>
git worktree add -b <new-branch> <path> <remote>/<base>
```

Check out an existing branch only when no other worktree holds it:

```bash
git worktree add <path> <branch>
```

For read-only review of an exact revision, use detached state deliberately and report it:

```bash
git worktree add --detach <path> <sha>
```

Never use `--force` to defeat branch occupancy, missing-path, or locked-worktree safeguards without an exact diagnosis and authorization.

## Operate safely

Run status and mutation commands with the intended worktree as the working directory. A clean status in one worktree says nothing about another. Shared refs mean a branch create, rename, delete, fetch, or prune can affect every linked worktree.

Per-worktree configuration requires the repository extension `extensions.worktreeConfig`. Enabling it changes configuration behavior for the whole repository. Do so only when requested and then use `git config --worktree` for the intended setting.

Submodule support and movement restrictions vary by Git version and repository state. Check `git worktree <subcommand> -h` and inspect submodules before moving or removing a populated worktree.

## Move, lock, and repair

```bash
git worktree move <old-path> <new-path>
git worktree lock --reason "<reason>" <path>
git worktree unlock <path>
git worktree repair <path>
```

Lock a worktree whose directory can disappear temporarily, such as removable or network storage. A lock prevents automatic pruning; it is not a filesystem lock and does not protect files from other processes.

Use `repair` after a worktree or main repository moved outside Git's worktree command. Inspect the proposed paths and re-run `list --porcelain` afterward. Do not edit administrative files under the common Git directory by hand.

## Remove and prune

Before removal, inspect from inside the target:

```bash
git -C <path> status --short --branch
git -C <path> log --oneline --decorate -5
```

Confirm there are no uncommitted, untracked, ignored-but-important, or unpushed changes. Then:

```bash
git worktree remove <path>
```

Do not use `git worktree remove --force` merely because normal removal refuses. Preserve the work or resolve the exact condition first. Removing a worktree does not delete its branch; branch deletion is a separate confirmed action.

Prune only stale administrative records after a dry run:

```bash
git worktree prune --dry-run --verbose
git worktree prune --verbose
```

Never prune while an unavailable worktree may return. Verify the final worktree inventory and the retained branches.
