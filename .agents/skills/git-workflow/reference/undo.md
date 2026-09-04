# Undo and discard

Choose the result before choosing a command. Working-tree files, the index, commits, and published history are different layers. A command that is safe for one can destroy another.

## Decision table

| Intended result | Usual operation | Main risk |
| --- | --- | --- |
| Unstage, keep file edits | `git restore --staged -- <path>` | Low; index changes |
| Discard unstaged tracked edits | `git restore --worktree -- <path>` | Deletes uncommitted edits |
| Restore a path from a commit | `git restore --source=<sha> -- <path>` | Replaces working-tree content |
| Undo a shared commit | `git revert <sha>` | Creates a new inverse commit |
| Move an owned unpublished branch while keeping changes | `git reset --soft` or mixed reset | Rewrites the branch ref |
| Delete untracked files | `git clean` after a matching dry run | Files may be unrecoverable |
| Put work aside temporarily | named `git stash push` | Easy to omit files or lose context |

Inspect status, both diffs, and the exact source revision first. Require authorization for discarding tracked edits, hard reset, clean, stash drop/clear, or another hard-to-recover outcome.

## Restore and unstage

Unstage without touching the working tree:

```bash
git diff --cached -- <path>
git restore --staged -- <path>
```

Discard tracked working-tree edits only after showing the diff:

```bash
git diff -- <path>
git restore --worktree -- <path>
```

When restoring from another revision, name the source. Add `--staged` only when the index should also change. Do not use a broad pathspec until every affected path is known.

## Revert

Use a new inverse commit for shared, default, release, or reviewed history:

```bash
git show --stat --oneline <sha>
git revert --no-commit <sha>
git diff --cached
git commit -F <reviewed-message-file>
```

`--no-commit` permits inspection before the commit but still changes the index and working tree. Stop on conflicts. Reverting a merge requires choosing the mainline parent and has future re-merge consequences; read [merge.md](merge.md#reverting-a-merge).

## Reset

`reset` moves a ref and may also change the index or working tree:

| Mode | Branch | Index | Working tree |
| --- | --- | --- | --- |
| `--soft` | moves | unchanged | unchanged |
| `--mixed` | moves | reset | unchanged |
| `--hard` | moves | reset | reset, destructive |

All branch-moving reset modes rewrite history. Record the original SHA and create a backup ref first. Never use `--hard` as a generic way to make status clean.

## Clean

`git clean` deletes untracked files outside normal Git recovery. Make the dry run match the intended destructive invocation exactly:

```bash
git clean -nd                 # untracked files and directories
git clean -ndX                # ignored files only
git clean -ndx                # untracked and ignored files
```

Review every path, then obtain confirmation for that exact class. Do not add `-x`, `-d`, nested-repository force flags, or interactive answers after approval without re-previewing. Prefer moving valuable outputs to a reviewed temporary location when practical.

## Stash

Inspect the file classes first:

```bash
git status --short
git stash push -m "<specific purpose>" -- <path>...
```

By default, a stash includes tracked changes and leaves untracked files behind. `-u` includes untracked files. `-a` also includes ignored files and has a much wider effect. Use the narrowest reviewed choice. A stash is repository-local and not a durable collaboration or backup mechanism.

Inspect before restoration:

```bash
git stash list
git stash show --stat stash@{<n>}
git stash show -p stash@{<n>}
git stash apply stash@{<n>}
```

Prefer `apply` first so the stash remains if restoration conflicts or verification fails. Stop on conflicts. Drop the exact stash only after the restored state is verified and its removal is authorized. Never use `stash clear` as cleanup without inspecting every entry.

## Verify

Re-read status, both diffs, `HEAD`, and affected refs. Confirm that preserved edits still exist, discarded paths match the requested source, and any revert or reset points to the expected tree. Report the recovery ref before deleting it.
