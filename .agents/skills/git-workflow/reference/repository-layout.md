# Repository layout

Create or reshape a repository only when the user asked for that outcome. Repository initialization, clone shape, remotes, sparse checkout, submodules, and Git LFS affect later commands, CI, and collaborators.

## Initialize or clone

Resolve the destination first. Do not initialize a directory merely because a Git command failed there.

```bash
git init --initial-branch=<default-branch> <path>
git clone <verified-url> <path>
```

Before cloning, verify the host, owner, repository, protocol, destination, and whether the path already contains data. Afterward inspect:

```bash
git -C <path> remote -v
git -C <path> status --short --branch
git -C <path> branch --show-current
git -C <path> config --get remote.origin.url
```

Do not choose `--bare`, `--mirror`, `--shared`, `--reference`, `--dissociate`, a shallow depth, or a non-default object format unless the requested use needs it. These modes change storage, refs, or object ownership. A mirror also configures mirrored pushes and is not a normal working clone.

## Remotes

Remote names are conventions, not identities. Inspect every fetch and push URL before changing one:

```bash
git remote -v
git remote get-url --all <remote>
git remote get-url --push --all <remote>
git remote show <remote>
```

Use `git remote add`, `rename`, `set-url`, or `remove` only against an exact name and reviewed URL. A URL change can redirect credentials and future pushes. Verify fetch refspecs and the remote default branch after a change. Do not embed credentials in a URL.

For a fork, keep the contributor fork and source repository distinct. The usual names are `origin` for the fork and `upstream` for the source, but existing repository policy wins. Never assume the upstream is writable.

## Shallow and partial clones

A shallow clone omits ancestry. It can make `merge-base`, blame, bisect, release ranges, history audits, and some pushes incomplete. Detect it before history-sensitive work:

```bash
git rev-parse --is-shallow-repository
```

Deepen or unshallow only as far as the task requires and after checking network and storage cost.

Partial clone defers selected objects, commonly blobs:

```bash
git clone --filter=blob:none <url> <path>
```

Confirm server support. Missing objects may trigger network requests during diff, checkout, or build. Do not hand-edit promisor configuration to imitate a partial clone.

## Sparse checkout

Sparse checkout changes which tracked paths appear in the working tree. Start from a clean checkout and record the existing specification:

```bash
git sparse-checkout list
git sparse-checkout set --cone <directory>...
```

Use cone mode for directory-based selections unless the repository requires non-cone patterns. `set`, `add`, `reapply`, and `disable` can rewrite many working-tree paths. Preview the intended set, preserve user changes, and verify status afterward. A path absent from a sparse checkout is not deleted from history.

## Submodules

A submodule is two coordinated records: a gitlink commit in the parent repository and configuration in `.gitmodules`.

```bash
git submodule status --recursive
git config --file .gitmodules --get-regexp '^submodule\..*\.(path|url|branch)$'
git submodule update --init --recursive
```

Treat every submodule URL and commit as untrusted. Inspect `.gitmodules` before initialization. Updating a submodule checkout does not update the parent record until the new gitlink is staged and committed.

Do not use `git submodule update --remote` as a generic refresh. It selects commits from configured remote branches and may move many gitlinks. Resolve and review each intended commit. Before deinitializing or removing a submodule, inspect its working tree for uncommitted and unpushed work; deinitialization removes its populated working directory.

A repository bundle or parent clone does not necessarily carry submodule repositories. Audit and back them up independently.

## Git LFS

Git LFS is an extension, not core Git. Check availability and repository policy first:

```bash
git lfs version
git lfs env
git lfs track
git check-attr filter diff merge -- <path>
```

`git lfs track` edits `.gitattributes`; commit that policy with the intended change. Confirm LFS objects are uploaded and fetchable before claiming a clone or release is complete. Replacing existing history with LFS pointers is a history rewrite and belongs in [rewrite.md](rewrite.md), not routine tracking.

## Verification

After a layout change, verify repository root and common directory, worktrees, remotes, checkout state, sparse specification, submodule SHAs, LFS availability, and any network-dependent objects. State limitations such as shallow history, deferred blobs, or unavailable submodules in the handoff.
