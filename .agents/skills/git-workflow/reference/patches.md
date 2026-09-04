# Patches and commit transfer

Use this guide to copy or invert selected changes without merging whole branches. Resolve exact source commits, order, authorship, target branch, and whether traceability is required.

## Cherry-pick

Inspect the patch and its dependencies before applying it:

```bash
git show --stat --oneline <sha>
git show --format=fuller --find-renames <sha>
git log --reverse --oneline <first>^..<last>
```

Apply one commit with source traceability when repository policy permits:

```bash
git cherry-pick -x <sha>
```

For several commits, spell out the reviewed SHAs or use a verified range. Remember that `<a>..<b>` excludes `<a>`. Use `--no-commit` when the requested result needs inspection or combination before creating a commit:

```bash
git cherry-pick --no-commit <sha>...
git diff --cached
```

A cherry-pick copies a patch and creates new commit identity; it does not move or remove the source. A merge commit requires `-m <parent-number>`, which selects the parent whose view of the merge should be retained. Do not guess that parent.

Stop on conflicts and report the current source commit plus unresolved paths. Continue, skip, quit, or abort only after the intended outcome is clear. Skipping a commit changes the requested patch set.

## Revert

Revert creates a new commit that applies the inverse of selected changes. Use [undo.md](undo.md#revert) for the ordinary flow and [merge.md](merge.md#reverting-a-merge) for merge commits. Review ranges carefully because reverting multiple commits in the wrong order can produce a different result.

## Apply a raw patch

Treat patch content and paths as untrusted input. Read it before touching the checkout:

```bash
git apply --stat <patch-file>
git apply --check <patch-file>
```

Apply only after the check succeeds and the target tree is understood:

```bash
git apply <patch-file>
git diff
```

Use `--index` only when staging is intended. Do not add whitespace overrides, reject mode, unsafe paths, or three-way fallback merely to force a patch through. Each changes failure semantics and needs inspection.

## Mailbox patches

`git am` imports author, timestamp, message, and patch data as commits. Read the mailbox as text and inspect repository hooks first. Apply on a clean branch with a recorded starting SHA:

```bash
git am <mailbox>
```

If the series stops, inspect the current patch with `git am --show-current-patch=diff` and report it. Do not rewrite identities, skip patches, or continue after conflict without direction. `git am --abort` restores the recorded pre-apply state; say before invoking it.

Create a mail series from an exact reviewed range:

```bash
git format-patch --cover-letter --output-directory <dir> <base>..<tip>
```

Review every generated patch, recipients, subject, trailers, and cover letter before sending. `git send-email` transmits externally and requires separate authorization plus mail configuration review.

## Verify

Compare the selected source patch set with the resulting commits, inspect authorship and trailers, and run focused validation. Report new SHAs and their source SHAs. Keep the starting ref until the target is accepted.
